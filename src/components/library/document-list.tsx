'use client';

import { Eye, Pencil } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

import { FileIcon } from '@/components/library/file-icon';
import { ownedFileTypeLabel, type DocumentKind } from '@/lib/library-layout';
import { formatDate, formatItemCount, formatSize } from '@/components/library/format';
import {
  CLIENT_DOCUMENT_STATE_LABELS,
  docTypeLabel,
  FOLDER_TYPE_LABEL,
  GENERATED_STATE_LABELS,
  TEMPLATE_EDIT_LABELS,
  type ClientDocumentState,
  type ConversionState,
} from '@/lib/types';

// The one document list in the app.
//
// The Library and the analysis wizard's picker had grown two near-identical tables that had
// already drifted: the picker sorted by folder and could preview, the Library sorted by size
// and could not. Whatever a person learns about choosing documents in one place should hold
// in the other, so there is one table and the differences are props.

export type ListColumn = 'select' | 'name' | 'type' | 'folder' | 'modified' | 'size' | 'pages' | 'state' | 'actions';
export type SortKey = 'name' | 'type' | 'modified' | 'size' | 'state';

export type FolderRow = {
  kind: 'folder';
  id: string;
  name: string;
  path: string;
  itemCount: number;
  pendingCount: number;
  modifiedAt: number;
};

export type FileRow = {
  kind: 'file';
  id: string;
  name: string;
  title: string;
  path: string;
  docType: string;
  sourceKind: string;
  size: number;
  modifiedAt: number;
  clientState: ClientDocumentState;
  stateDetail: string;
  ocrPendingPages: number;
  pageCount: number;
  documentKind: DocumentKind;
  /** Non-empty when the file is a template's published copy; the row then offers its editor. */
  templateId: string;
  /** A generated output's conversion state, for the Estado column. */
  outputState: string;
  /** A template's Estado: whether the client has changed it. */
  templateEdited: boolean;
};

export type ListRow = FolderRow | FileRow;

export type RowAction = { label: string; onSelect: () => void; danger?: boolean };

export function DocumentList({
  rows,
  columns,
  selection,
  sort,
  onSortChange,
  onOpenFolder,
  onOpenFile,
  onPreview,
  onEditTemplate,
  rowActions,
  rowTarget,
  onDropFiles,
  emptyState,
  loading = false,
  footer,
}: {
  rows: ListRow[];
  columns: ListColumn[];
  selection: { mode: 'none' | 'single' | 'multi'; selectedIds: string[]; onChange: (ids: string[]) => void };
  /** null when the server did the sorting — the header still toggles, it just asks upstream. */
  sort: { key: SortKey; dir: 'asc' | 'desc' } | null;
  onSortChange?: (next: { key: SortKey; dir: 'asc' | 'desc' }) => void;
  onOpenFolder?: (path: string) => void;
  onOpenFile?: (row: FileRow) => void;
  onPreview?: (row: FileRow) => void;
  onEditTemplate?: (row: FileRow) => void;
  rowActions?: (row: ListRow) => RowAction[];
  /** Stable tutorial anchor; absent in the live application. */
  rowTarget?: (row: ListRow) => string | undefined;
  onDropFiles?: (files: File[]) => void;
  emptyState: { title: string; description?: string };
  loading?: boolean;
  footer?: ReactNode;
}) {
  const [dragging, setDragging] = useState(false);
  // A counter, not a boolean: dragging over a child fires dragleave on the parent, so a
  // naive flag flickers off every time the pointer crosses a row.
  const dragDepth = useRef(0);
  const lastClicked = useRef<string>('');

  const selected = new Set(selection.selectedIds);
  const folders = rows.filter((row): row is FolderRow => row.kind === 'folder');
  const files = rows.filter((row): row is FileRow => row.kind === 'file');
  // Folders first, always — OneDrive does it and it is what people expect of a file list.
  const ordered: ListRow[] = [...folders, ...files];

  function toggle(row: ListRow, event: React.MouseEvent) {
    if (selection.mode === 'none') return;
    if (selection.mode === 'single') {
      selection.onChange(selected.has(row.id) ? [] : [row.id]);
      return;
    }
    if (event.shiftKey && lastClicked.current) {
      const from = ordered.findIndex((r) => r.id === lastClicked.current);
      const to = ordered.findIndex((r) => r.id === row.id);
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from];
        const range = ordered.slice(start, end + 1).map((r) => r.id);
        selection.onChange([...new Set([...selection.selectedIds, ...range])]);
        return;
      }
    }
    lastClicked.current = row.id;
    selection.onChange(
      selected.has(row.id) ? selection.selectedIds.filter((id) => id !== row.id) : [...selection.selectedIds, row.id],
    );
  }

  // Nome is the only column that gives ground, and below a certain width it has none left
  // to give — at 1024px the fixed columns ate it entirely and every file name vanished. So
  // the secondary columns step aside instead, which keeps the no-sideways-scroll rule true
  // at every width rather than only on a wide monitor.
  const RESPONSIVE: Partial<Record<ListColumn, string>> = {
    modified: 'hidden 2xl:table-cell',
    size: 'hidden xl:table-cell',
    folder: 'hidden xl:table-cell',
  };

  const header = (key: SortKey, label: string, align?: 'right', width?: string) => (
    <th
      key={key}
      className={`px-4 py-2.5 font-medium ${width || ''} ${RESPONSIVE[key as ListColumn] || ''} ${
        align === 'right' ? 'text-right' : ''
      }`}
    >
      <button
        type="button"
        onClick={() => onSortChange?.({ key, dir: sort?.key === key && sort.dir === 'asc' ? 'desc' : 'asc' })}
        className="inline-flex items-center gap-1 hover:text-ink0"
      >
        {label}
        <span className="text-xs">{sort?.key === key ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  );

  const body = (
    // table-fixed, and every column but Nome is wide enough for its longest possible value
    // on ONE line, measured in the browser: "Código de conduta" needs 190px with padding and
    // the "Indexado com alerta de OCR" pill needs 250px. Nome takes whatever is left and
    // truncates. Without the fixed layout a long title widened the table past its container
    // and the whole list scrolled sideways.
    <table className="w-full table-fixed border-collapse text-base">
      <thead className="sticky top-0 z-10 bg-surface">
        <tr className="text-left ui-text-muted">
          {columns.includes('select') ? <th className="w-10 px-4 py-2.5" aria-label="Selecionar" /> : null}
          {columns.includes('name') ? header('name', 'Nome') : null}
          {columns.includes('type') ? header('type', 'Tipo', undefined, 'w-52') : null}
          {columns.includes('folder') ? (
            <th className={`w-56 px-4 py-2.5 font-medium ${RESPONSIVE.folder}`}>Pasta</th>
          ) : null}
          {columns.includes('modified') ? header('modified', 'Modificado', undefined, 'w-36') : null}
          {columns.includes('size') ? header('size', 'Tamanho', 'right', 'w-28') : null}
          {columns.includes('pages') ? <th className="w-24 px-4 py-2.5 text-right font-medium">Páginas</th> : null}
          {columns.includes('state') ? header('state', 'Estado', undefined, 'w-64') : null}
          {columns.includes('actions') ? <th className="w-24 px-4 py-2.5" aria-label="Ações" /> : null}
        </tr>
      </thead>
      <tbody>
        {ordered.map((row) => {
          const isSelected = selected.has(row.id);
          return (
            <tr
              key={row.id}
              data-tutorial-target={rowTarget?.(row)}
              onClick={() => (row.kind === 'folder' ? onOpenFolder?.(row.path) : onOpenFile?.(row))}
              // Fixed height, so a row with a title under its name and a row without are
              // the same size and the list reads as a grid rather than a ragged stack. The
              // value has to EXCEED the tallest content (a name over a title, ~69px) or the
              // content binds instead and the rows go ragged again by a pixel.
              className={`h-[72px] cursor-pointer border-t border-line0 ${
                isSelected ? 'bg-accent-ghost' : 'hover:bg-surface-soft'
              }`}
            >
              {columns.includes('select') ? (
                <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <span
                    role="checkbox"
                    tabIndex={0}
                    aria-checked={isSelected}
                    onClick={(e) => toggle(row, e)}
                    onKeyDown={(e) => e.key === ' ' && toggle(row, e as unknown as React.MouseEvent)}
                    className={`inline-flex h-4 w-4 items-center justify-center border text-xs ${
                      selection.mode === 'single' ? 'rounded-full' : 'rounded'
                    } ${isSelected ? 'border-accent bg-accent text-white' : 'border-line1'}`}
                  >
                    {isSelected ? '✓' : ''}
                  </span>
                </td>
              ) : null}

              {columns.includes('name') ? (
                <td className="overflow-hidden px-4 py-2.5">
                  <span className="flex items-center gap-2.5">
                    <FileIcon isFolder={row.kind === 'folder'} kind={row.kind === 'file' ? row.sourceKind : undefined} />
                    <span className="min-w-0 flex-1">
                      {/* Titles, because the column truncates whatever does not fit. */}
                      <span className="block truncate font-medium text-ink0" title={row.name}>
                        {row.name}
                      </span>
                      {row.kind === 'file' && row.title && row.title !== row.name ? (
                        <span className="block truncate text-sm ui-text-muted" title={row.title}>
                          {row.title}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </td>
              ) : null}

              {columns.includes('type') ? (
                <td className="truncate px-4 py-2.5 ui-text-muted">
                  {row.kind === 'folder'
                    ? FOLDER_TYPE_LABEL
                    : ownedFileTypeLabel(row.documentKind, row.name) || docTypeLabel(row.docType)}
                </td>
              ) : null}

              {columns.includes('folder') ? (
                <td className={`truncate px-4 py-2.5 ui-text-muted ${RESPONSIVE.folder}`} title={row.path || undefined}>
                  {row.path || '—'}
                </td>
              ) : null}

              {columns.includes('modified') ? (
                <td className={`truncate whitespace-nowrap px-4 py-2.5 ui-text-muted ${RESPONSIVE.modified}`}>
                  {formatDate(row.modifiedAt)}
                </td>
              ) : null}

              {columns.includes('size') ? (
                <td className={`whitespace-nowrap px-4 py-2.5 text-right ui-text-muted ${RESPONSIVE.size}`}>
                  {row.kind === 'folder' ? formatItemCount(row.itemCount) : formatSize(row.size)}
                </td>
              ) : null}

              {columns.includes('pages') ? (
                <td className="px-4 py-2.5 text-right">{row.kind === 'file' ? row.pageCount || '—' : '—'}</td>
              ) : null}

              {columns.includes('state') ? (
                <td className="px-4 py-2.5">
                  <StateCell row={row} />
                </td>
              ) : null}

              {columns.includes('actions') ? (
                <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                  <span className="flex justify-end gap-1">
                    {row.kind === 'file' && row.templateId && onEditTemplate ? (
                      <button
                        type="button"
                        title={`Editar “${row.name}”`}
                        aria-label={`Editar “${row.name}”`}
                        onClick={() => onEditTemplate(row)}
                        className="ui-btn-secondary rounded-md px-2 py-1 leading-none"
                      >
                        <Pencil size={15} aria-hidden />
                      </button>
                    ) : null}
                    {row.kind === 'file' && onPreview ? (
                      <button
                        type="button"
                        title={`Pré-visualizar “${row.name}”`}
                        aria-label={`Pré-visualizar “${row.name}”`}
                        onClick={() => onPreview(row)}
                        className="ui-btn-secondary rounded-md px-2 py-1 leading-none"
                      >
                        <Eye size={15} aria-hidden />
                      </button>
                    ) : null}
                    {rowActions ? <RowMenu actions={rowActions(row)} /> : null}
                  </span>
                </td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const dropHandlers = onDropFiles
    ? {
        onDragEnter: (e: React.DragEvent) => {
          e.preventDefault();
          dragDepth.current += 1;
          if (e.dataTransfer.types.includes('Files')) setDragging(true);
        },
        onDragOver: (e: React.DragEvent) => e.preventDefault(),
        onDragLeave: () => {
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) setDragging(false);
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          const files = Array.from(e.dataTransfer.files || []);
          if (files.length) onDropFiles(files);
        },
      }
    : {};

  return (
    <div className="relative" {...dropHandlers}>
      {ordered.length === 0 && !loading ? (
        <div className="ui-soft-panel rounded-xl px-8 py-12 text-center">
          <p className="m-0 text-lg font-medium text-ink0">{emptyState.title}</p>
          {emptyState.description ? (
            <p className="mt-1.5 mb-0 text-base ui-text-muted">{emptyState.description}</p>
          ) : null}
        </div>
      ) : (
        <div className="ui-panel max-h-full overflow-y-auto rounded-xl">{body}</div>
      )}
      {footer}
      {dragging ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent-soft">
          <p className="m-0 text-base font-medium text-accent-strong">Largue para carregar</p>
        </div>
      ) : null}
    </div>
  );
}

const OUTPUT_TONES: Record<ConversionState, string> = {
  pendente: 'ui-pill-accent',
  em_conversao: 'ui-pill-accent',
  pronto_para_revisao: 'ui-pill-warn',
  aprovado_para_envio: 'ui-pill-ok',
  erro: 'ui-pill-error',
  desatualizado: 'ui-pill-warn',
};

const STATE_TONES: Record<ClientDocumentState, string> = {
  recebido: 'ui-pill-info',
  em_extracao: 'ui-pill-accent',
  em_ocr: 'ui-pill-accent',
  em_classificacao: 'ui-pill-accent',
  indexado: 'ui-pill-ok',
  indexado_com_alerta: 'ui-pill-warn',
  erro: 'ui-pill-error',
  em_falta: 'ui-pill-warn',
  eliminado: 'ui-pill-warn',
};

function StateCell({ row }: { row: ListRow }) {
  if (row.kind === 'folder') {
    return row.pendingCount > 0 ? (
      <span className="ui-pill-warn whitespace-nowrap rounded-md px-2 py-0.5 text-sm">
        {row.pendingCount} por processar
      </span>
    ) : (
      <span className="ui-text-subtle">—</span>
    );
  }
  // Neither a template nor a generated document is READ, so neither has a processing state.
  // What each has instead is its own question: has this model been customised, and was this
  // output approved. Saying "Template" here said only what the Tipo column now says.
  if (row.documentKind === 'template') {
    return row.templateEdited ? (
      <span className="ui-pill-accent whitespace-nowrap rounded-md px-2 py-0.5 text-sm">
        {TEMPLATE_EDIT_LABELS.edited}
      </span>
    ) : (
      <span className="ui-pill-info whitespace-nowrap rounded-md px-2 py-0.5 text-sm">
        {TEMPLATE_EDIT_LABELS.original}
      </span>
    );
  }
  if (row.documentKind === 'generated') {
    const state = row.outputState as ConversionState;
    if (!GENERATED_STATE_LABELS[state]) return <span className="ui-text-subtle">—</span>;
    return (
      <span className={`${OUTPUT_TONES[state]} whitespace-nowrap rounded-md px-2 py-0.5 text-sm`}>
        {GENERATED_STATE_LABELS[state]}
      </span>
    );
  }
  return (
    <span
      className={`${STATE_TONES[row.clientState]} whitespace-nowrap rounded-md px-2 py-0.5 text-sm`}
      title={row.stateDetail || undefined}
    >
      {CLIENT_DOCUMENT_STATE_LABELS[row.clientState]}
    </span>
  );
}

function RowMenu({ actions }: { actions: RowAction[] }) {
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const open = at !== null;
  if (actions.length === 0) return null;
  // Positioned against the viewport, not the row: the list scrolls inside a clipping panel,
  // which cut every menu off at the card's edge and made the last actions unreachable.
  function toggle() {
    if (open) return setAt(null);
    const box = trigger.current?.getBoundingClientRect();
    if (box) setAt({ top: box.bottom + 4, right: window.innerWidth - box.right });
  }
  return (
    <span className="relative">
      <button
        ref={trigger}
        type="button"
        aria-label="Mais ações"
        onClick={toggle}
        onBlur={() => window.setTimeout(() => setAt(null), 150)}
        className="ui-btn-secondary rounded-md px-2 py-1 leading-none"
      >
        ⋯
      </button>
      {at ? (
        <span
          style={{ top: at.top, right: at.right }}
          className="ui-panel fixed z-50 flex w-48 flex-col rounded-lg p-1 text-left"
        >
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => {
                setAt(null);
                action.onSelect();
              }}
              className={`rounded-md px-3 py-1.5 text-left text-sm hover:bg-surface-soft ${
                action.danger ? 'text-danger' : 'text-ink1'
              }`}
            >
              {action.label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}
