'use client';

import { useMemo, useRef, useState } from 'react';

import { DocumentList, type FileRow, type ListRow, type SortKey } from '@/components/library/document-list';
import { usePreview } from '@/components/library/preview-context';
import { useUploadQueue } from '@/components/library/use-upload-queue';
import { UPLOAD_ACCEPT_ATTR } from '@/lib/ingest-types';
import { LIBRARY_FOLDERS } from '@/lib/library-layout';
import { foldedIncludes } from '@/lib/text-normalize';
import type { ClientDocumentState, DocumentState } from '@/lib/types';

// Choosing documents for an analysis.
//
// The mechanics — the table, sorting, selection, preview, drag-and-drop — are the shared
// DocumentList. What lives here is the POLICY: which documents may be chosen at all, and
// that a pick is a selection rather than a navigation. The two used to be separate tables
// and had already drifted apart in both directions.

export type PickerDoc = {
  documentId: string;
  name: string;
  title: string;
  docType: string;
  sourceKind?: string;
  pageCount: number;
  path: string;
  /** The coarse pipeline value, for callers asking whether a document can be USED yet. */
  state: DocumentState;
  /** §6's state, for showing one. */
  clientState: ClientDocumentState;
  ocrPendingPages: number;
  driveModifiedAt: number;
};

export function DocumentPicker({
  docs,
  mode,
  selectedIds,
  onToggle,
  onUploaded,
  emptyHint,
  rowTarget,
}: {
  docs: PickerDoc[];
  mode: 'single' | 'multi';
  selectedIds: string[];
  onToggle: (documentId: string) => void;
  onUploaded: () => Promise<void> | void;
  emptyHint?: string;
  rowTarget?: (documentId: string) => string | undefined;
}) {
  const preview = usePreview();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const fileRef = useRef<HTMLInputElement>(null);

  const uploads = useUploadQueue({ folder: LIBRARY_FOLDERS.official, onUploaded });

  const rows: ListRow[] = useMemo(() => {
    // Product rule: Library selection search is a filename/title search, never a hidden
    // full-text or metadata search. The same promise is made in the main Library.
    const matches = (doc: PickerDoc) =>
      !query || [doc.name, doc.title].some((field) => foldedIncludes(String(field || ''), query));

    const mapped: FileRow[] = docs.filter(matches).map((doc) => ({
      kind: 'file' as const,
      id: doc.documentId,
      name: doc.name,
      title: doc.title,
      path: doc.path,
      docType: doc.docType,
      sourceKind: doc.sourceKind || '',
      size: 0,
      modifiedAt: doc.driveModifiedAt,
      clientState: doc.clientState,
      stateDetail: '',
      ocrPendingPages: doc.ocrPendingPages,
      pageCount: doc.pageCount,
      documentKind: 'official' as const,
      templateId: '',
      outputState: '',
      templateEdited: false,
    }));

    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...mapped].sort((a, b) => {
      if (sort.key === 'modified') return (a.modifiedAt - b.modifiedAt) * factor;
      if (sort.key === 'size') return (a.pageCount - b.pageCount) * factor;
      const key = sort.key === 'type' ? 'docType' : 'name';
      return String(a[key]).localeCompare(String(b[key]), 'pt', { numeric: true, sensitivity: 'base' }) * factor;
    });
  }, [docs, query, sort]);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filtrar por nome…"
          className="ui-input min-w-56 flex-1 rounded-md px-3 py-2 text-base"
        />
        <button
          type="button"
          disabled={uploads.busy}
          onClick={() => fileRef.current?.click()}
          className="ui-btn-secondary whitespace-nowrap rounded-md px-3.5 py-2 text-base"
        >
          {uploads.busy ? 'A carregar…' : '+ Carregar documento'}
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT_ATTR}
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            if (files.length) void uploads.upload(files);
            e.target.value = '';
          }}
        />
      </div>

      {uploads.entries.length > 0 ? (
        <div className="ui-soft-panel grid gap-1 rounded-lg px-3 py-2 text-sm">
          {uploads.entries.map((entry) => (
            <p key={entry.name} className="m-0">
              <span className="font-medium text-ink0">{entry.name}</span>{' '}
              <span className={entry.status === 'error' ? 'text-danger' : 'ui-text-muted'}>{entry.detail}</span>
            </p>
          ))}
        </div>
      ) : null}

      <DocumentList
        rows={rows}
        columns={['select', 'name', 'type', 'folder', 'modified', 'pages', 'actions']}
        selection={{
          mode,
          selectedIds,
          // The wizard owns which documents are chosen, so selection is reported one id at a
          // time rather than as a replacement set.
          onChange: (next) => {
            const added = next.find((id) => !selectedIds.includes(id));
            const removed = selectedIds.find((id) => !next.includes(id));
            if (added) onToggle(added);
            else if (removed) onToggle(removed);
          },
        }}
        sort={sort}
        onSortChange={setSort}
        onOpenFile={(row) => onToggle(row.id)}
        rowTarget={(row) => rowTarget?.(row.id)}
        onPreview={(row) => preview.open({ documentId: row.id, name: row.name })}
        onDropFiles={(files) => void uploads.upload(files)}
        emptyState={{
          title: query ? 'Nada corresponde ao filtro' : 'Sem documentos disponíveis',
          description: query ? undefined : emptyHint || 'A biblioteca ainda não tem documentos indexados.',
        }}
      />
    </div>
  );
}
