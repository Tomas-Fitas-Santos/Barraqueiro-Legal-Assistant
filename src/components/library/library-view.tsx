'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  DocumentList,
  type FileRow,
  type ListRow,
  type RowAction,
  type SortKey,
} from '@/components/library/document-list';
import { LibraryMovePrompt } from '@/components/library/library-move-prompt';
import { usePreview } from '@/components/library/preview-context';
import { useUploadQueue } from '@/components/library/use-upload-queue';
import { PageHeader } from '@/components/ui/page';
import { UPLOAD_ACCEPT_ATTR } from '@/lib/ingest-types';
import { isGeneratedOutput, LIBRARY_FOLDERS } from '@/lib/library-layout';

// The Library, browsed the way the client already browses OneDrive: folders first, the same
// columns, a breadcrumb, and a contextual toolbar over a multi-selectable list.
//
// The filter box filters NAMES — files and folders — and nothing else. It does not read the
// documents: the semantic index exists to serve the analyses, not this screen.

type ListPayload = {
  ok: boolean;
  configured: boolean;
  path: string;
  breadcrumb: Array<{ name: string; path: string }>;
  folders: Array<{
    folderId: string;
    name: string;
    path: string;
    itemCount: number;
    pendingCount: number;
    modifiedAt: number;
  }>;
  files: Array<Omit<FileRow, 'kind' | 'id'> & { documentId: string }>;
  nextCursor: string;
  totals: { folders: number; files: number };
  lastSync: { at: number; status: string };
  /** Material still sitting outside the app's folders — the migration screen has work. */
  migrationPending: boolean;
};

/** The one prompt this screen needs: a name to type, or a folder to pick. */
type Dialog =
  | { kind: 'new-folder'; value: string }
  | { kind: 'rename'; row: ListRow; value: string }
  | { kind: 'move'; row: ListRow; value: string };

export function LibraryView() {
  const router = useRouter();
  const params = useSearchParams();
  const preview = usePreview();

  const folder = params.get('path') || '';
  const sortKey = (params.get('sort') || 'name') as SortKey;
  const sortDir = (params.get('dir') || 'asc') as 'asc' | 'desc';
  const query = params.get('q') || '';
  const recursive = params.get('recursive') === '1';

  const [payload, setPayload] = useState<ListPayload | null>(null);
  const [extra, setExtra] = useState<ListPayload['files']>([]);
  const [cursor, setCursor] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [draft, setDraft] = useState(query);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // The whole view lives in the URL, so back, refresh and a shared link all work.
  const navigate = useCallback(
    (next: Record<string, string>) => {
      const search = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(next)) {
        if (value) search.set(key, value);
        else search.delete(key);
      }
      router.replace(`/library?${search.toString()}` as Route, { scroll: false });
    },
    [params, router],
  );

  const load = useCallback(async () => {
    setLoading(true);
    const search = new URLSearchParams({ path: folder, sort: sortKey, dir: sortDir });
    if (query) search.set('q', query);
    if (recursive) search.set('recursive', '1');
    const data = (await fetch(`/api/library/list?${search.toString()}`).then((r) => r.json())) as ListPayload;
    if (data.ok) {
      setPayload(data);
      setExtra([]);
      setCursor(data.nextCursor);
    }
    setLoading(false);
  }, [folder, sortKey, sortDir, query, recursive]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setSelected([]);
  }, [folder, query]);

  // Debounced so a filter does not fire a request per keystroke.
  useEffect(() => {
    if (draft === query) return;
    const timer = window.setTimeout(() => navigate({ q: draft, cursor: '' }), 250);
    return () => window.clearTimeout(timer);
  }, [draft, query, navigate]);

  const uploads = useUploadQueue({
    folder: folder || LIBRARY_FOLDERS.official,
    onUploaded: load,
  });

  const folderOptions = useFolderOptions(payload);

  const rows: ListRow[] = useMemo(() => {
    if (!payload) return [];
    return [
      ...payload.folders.map((f) => ({ kind: 'folder' as const, id: f.folderId, ...f })),
      ...[...payload.files, ...extra].map((f) => ({ kind: 'file' as const, id: f.documentId, ...f })),
    ];
  }, [payload, extra]);

  const selectedRows = rows.filter((row) => selected.includes(row.id));
  const selectedFiles = selectedRows.filter((row): row is FileRow & { kind: 'file' } => row.kind === 'file');

  async function loadMore() {
    if (!cursor) return;
    const search = new URLSearchParams({ path: folder, sort: sortKey, dir: sortDir, cursor });
    if (query) search.set('q', query);
    if (recursive) search.set('recursive', '1');
    const data = (await fetch(`/api/library/list?${search.toString()}`).then((r) => r.json())) as ListPayload;
    if (data.ok) {
      setExtra((current) => [...current, ...data.files]);
      setCursor(data.nextCursor);
    }
  }

  async function syncNow() {
    setBusy('sync');
    setNotice('');
    try {
      const data = await fetch('/api/library/sync', { method: 'POST' }).then((r) => r.json());
      setNotice(
        data.ok
          ? `Sincronizado — ${data.upserted} atualizado(s), ${data.removed} removido(s)` +
              (data.pending ? `, ${data.pending} por processar.` : '.') +
              (data.deferred ? ` ${data.deferred} adiado(s) para a próxima sincronização.` : '')
          : data.error || 'A sincronização falhou.',
      );
      await load();
    } finally {
      setBusy('');
    }
  }

  async function reprocess(ids: string[]) {
    setBusy('reprocess');
    setNotice('');
    try {
      for (const id of ids) {
        await fetch(`/api/library/documents/${id}/ingest`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ force: true }),
        });
      }
      setNotice(`${ids.length} documento(s) reprocessado(s).`);
      await load();
    } finally {
      setBusy('');
    }
  }

  async function remove(ids: string[]) {
    setBusy('delete');
    setNotice('');
    const failures: string[] = [];
    try {
      for (const id of ids) {
        const data = await fetch(`/api/library/documents/${id}`, { method: 'DELETE' }).then((r) => r.json());
        if (!data.ok) failures.push(data.error || id);
      }
      // Say which ones failed rather than reporting a single outcome for the batch.
      setNotice(
        failures.length
          ? `${ids.length - failures.length} eliminado(s); ${failures.length} falhou/falharam.`
          : `${ids.length} documento(s) eliminado(s).`,
      );
      setSelected([]);
      await load();
    } finally {
      setBusy('');
    }
  }

  async function submitDialog(value: string) {
    if (!dialog) return;
    setBusy('dialog');
    setNotice('');
    try {
      const request =
        dialog.kind === 'new-folder'
          ? { url: '/api/library/folders', method: 'POST', body: { parentPath: folder, name: value } }
          : dialog.kind === 'rename'
            ? {
                url:
                  dialog.row.kind === 'folder'
                    ? `/api/library/folders/${dialog.row.id}`
                    : `/api/library/documents/${dialog.row.id}`,
                method: 'PATCH',
                body: { name: value },
              }
            : {
                url:
                  dialog.row.kind === 'folder'
                    ? `/api/library/folders/${dialog.row.id}`
                    : `/api/library/documents/${dialog.row.id}`,
                method: 'PATCH',
                body: dialog.row.kind === 'folder' ? { parentPath: value } : { folderPath: value },
              };
      const data = await fetch(request.url, {
        method: request.method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.body),
      }).then((r) => r.json());
      if (!data.ok) {
        setNotice(data.error || 'A operação falhou.');
        return;
      }
      // Say when the change did not reach the drive, and say what a move changed about the
      // document — moving into Templates stops it being source material for an analysis.
      setNotice(
        [
          dialog.kind === 'new-folder' ? 'Pasta criada.' : dialog.kind === 'rename' ? 'Nome alterado.' : 'Movido.',
          data.note || '',
          data.syncedToDrive === false ? '(fica local — OneDrive não ligado)' : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
      setDialog(null);
      setSelected([]);
      await load();
    } finally {
      setBusy('');
    }
  }

  async function removeFolder(row: ListRow) {
    const impact = await fetch(`/api/library/folders/${row.id}`).then((r) => r.json());
    if (!impact.ok) {
      setNotice(impact.error || 'Não foi possível ler a pasta.');
      return;
    }
    // Graph's folder delete is always recursive, so the count has to come first.
    const { documents, folders } = impact.impact;
    const detail =
      documents || folders
        ? ` e os ${documents} ficheiro(s) e ${folders} subpasta(s) que contém`
        : '';
    if (!window.confirm(`Eliminar “${row.name}”${detail}?`)) return;
    setBusy('dialog');
    try {
      const data = await fetch(`/api/library/folders/${row.id}`, { method: 'DELETE' }).then((r) => r.json());
      setNotice(data.ok ? `Pasta eliminada — ${data.documentsRemoved} ficheiro(s).` : data.error || 'Falhou.');
      await load();
    } finally {
      setBusy('');
    }
  }

  const rowActions = (row: ListRow): RowAction[] => {
    if (row.kind === 'folder') {
      return [
        { label: 'Mudar o nome', onSelect: () => setDialog({ kind: 'rename', row, value: row.name }) },
        { label: 'Mover para…', onSelect: () => setDialog({ kind: 'move', row, value: '' }) },
        { label: 'Eliminar', danger: true, onSelect: () => void removeFolder(row) },
      ];
    }
    return [
      { label: 'Abrir detalhe', onSelect: () => router.push(`/library/${row.id}` as Route) },
      ...(row.templateId
        ? [
            {
              label: 'Editar template',
              onSelect: () => router.push(`/templates/${row.templateId}?from=/library` as Route),
            },
          ]
        : []),
      { label: 'Mudar o nome', onSelect: () => setDialog({ kind: 'rename', row, value: row.name }) },
      { label: 'Mover para…', onSelect: () => setDialog({ kind: 'move', row, value: row.path }) },
      { label: 'Pré-visualizar', onSelect: () => preview.open({ documentId: row.id, name: row.name }) },
      { label: 'Descarregar', onSelect: () => window.open(`/api/library/documents/${row.id}/download`, '_blank') },
      // Always offered, even for a clean document. It used to be hidden once a document was
      // indexed, which meant a healthy document could never be reprocessed from the UI at all.
      ...(row.documentKind === 'official' ? [{ label: 'Reprocessar', onSelect: () => void reprocess([row.id]) }] : []),
      { label: 'Eliminar', danger: true, onSelect: () => void remove([row.id]) },
    ];
  };

  const crumbs = payload?.breadcrumb || [{ name: 'Biblioteca', path: '' }];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Biblioteca"
        description="Espelho da pasta do OneDrive — as mesmas pastas e os mesmos ficheiros."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setDialog({ kind: 'new-folder', value: '' })}
              className="ui-btn-secondary rounded-md px-3.5 py-2 text-base"
            >
              + Nova pasta
            </button>
            <button
              type="button"
              disabled={uploads.busy}
              onClick={() => fileRef.current?.click()}
              className="ui-btn-secondary rounded-md px-3.5 py-2 text-base"
            >
              {uploads.busy ? 'A carregar…' : '+ Carregar ficheiros'}
            </button>
            <button
              type="button"
              disabled={busy === 'sync'}
              onClick={syncNow}
              className="ui-btn-primary rounded-md px-4 py-2 text-base disabled:opacity-50"
            >
              {busy === 'sync' ? 'A sincronizar…' : 'Sincronizar'}
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
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <nav className="flex min-w-0 flex-wrap items-center gap-1 text-base">
          {crumbs.map((crumb, index) => (
            <span key={crumb.path || 'root'} className="flex items-center gap-1">
              {index > 0 ? <span className="ui-text-subtle">/</span> : null}
              <button
                type="button"
                onClick={() => navigate({ path: crumb.path, q: '', cursor: '' })}
                className={index === crumbs.length - 1 ? 'font-medium text-ink0' : 'ui-link'}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Filtrar por nome…"
          className="ui-input ml-auto min-w-56 rounded-md px-3 py-1.5 text-base"
        />
        {query ? (
          <label className="flex items-center gap-1.5 text-sm ui-text-muted">
            <input
              type="checkbox"
              checked={recursive}
              onChange={(e) => navigate({ recursive: e.target.checked ? '1' : '', cursor: '' })}
            />
            Em toda a biblioteca
          </label>
        ) : null}
      </div>

      {selected.length > 0 ? (
        <div className="ui-soft-panel mb-3 flex flex-wrap items-center gap-2 rounded-lg px-3 py-2">
          <span className="text-base font-medium text-ink0">{selected.length} selecionado(s)</span>
          <span className="ml-auto flex flex-wrap gap-2">
            {selectedFiles.length === 1 ? (
              <button
                type="button"
                onClick={() => preview.open({ documentId: selectedFiles[0].id, name: selectedFiles[0].name })}
                className="ui-btn-secondary rounded-md px-3 py-1 text-sm"
              >
                Pré-visualizar
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy !== '' || selectedFiles.length === 0}
              onClick={() => void reprocess(selectedFiles.filter((f) => f.documentKind === 'official').map((f) => f.id))}
              className="ui-btn-secondary rounded-md px-3 py-1 text-sm disabled:opacity-50"
            >
              Reprocessar
            </button>
            <button
              type="button"
              disabled={busy !== '' || selectedFiles.length === 0}
              onClick={() => void remove(selectedFiles.map((f) => f.id))}
              className="ui-btn-danger rounded-md px-3 py-1 text-sm disabled:opacity-50"
            >
              Eliminar
            </button>
            <button type="button" onClick={() => setSelected([])} className="ui-btn-secondary rounded-md px-3 py-1 text-sm">
              Limpar
            </button>
          </span>
        </div>
      ) : null}

      {notice ? <p className="mb-3 mt-0 text-base ui-text-muted">{notice}</p> : null}
      <LibraryMovePrompt onDone={load} />
      {payload?.migrationPending ? (
        <p className="mb-3 mt-0 text-base ui-text-muted">
          Há documentos fora das pastas da aplicação, da altura anterior à reorganização.{' '}
          <Link className="underline" href="/library/migracao">
            Arrumar a biblioteca
          </Link>
          .
        </p>
      ) : null}
      {payload && !payload.configured ? (
        <p className="mb-3 mt-0 text-base ui-text-muted">
          OneDrive não está ligado — está a ver apenas os documentos locais. Ligue-o em Definições
          para espelhar a pasta do cliente.
        </p>
      ) : null}

      {uploads.entries.length > 0 ? (
        <div className="ui-soft-panel mb-3 grid gap-1 rounded-lg px-3 py-2 text-sm">
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
        loading={loading}
        columns={['select', 'name', 'type', 'modified', 'size', 'state', 'actions']}
        selection={{ mode: 'multi', selectedIds: selected, onChange: setSelected }}
        sort={{ key: sortKey, dir: sortDir }}
        onSortChange={(next) => navigate({ sort: next.key, dir: next.dir, cursor: '' })}
        onOpenFolder={(path) => navigate({ path, q: '', cursor: '' })}
        onOpenFile={(row) => router.push(`/library/${row.id}` as Route)}
        onPreview={(row) => preview.open({ documentId: row.id, name: row.name })}
        onEditTemplate={(row) => router.push(`/templates/${row.templateId}?from=/library` as Route)}
        rowActions={rowActions}
        onDropFiles={(files) => void uploads.upload(files)}
        emptyState={{
          title: query ? 'Nada corresponde ao filtro' : 'Pasta vazia',
          description: query
            ? 'O filtro procura por nome de ficheiro e de pasta.'
            : 'Carregue ficheiros ou sincronize com o OneDrive.',
        }}
        footer={
          cursor ? (
            <div className="mt-3 text-center">
              <button type="button" onClick={loadMore} className="ui-btn-secondary rounded-md px-4 py-1.5 text-base">
                Mostrar mais ({payload ? payload.totals.files - (payload.files.length + extra.length) : 0} restantes)
              </button>
            </div>
          ) : null
        }
      />

      {dialog ? (
        <ItemDialog
          dialog={dialog}
          busy={busy === 'dialog'}
          folderOptions={folderOptions}
          onCancel={() => setDialog(null)}
          onSubmit={submitDialog}
        />
      ) : null}
    </div>
  );
}

/** Every folder a move can target — the app's own output folder is not one of them. */
function useFolderOptions(payload: ListPayload | null): Array<{ label: string; value: string }> {
  return useMemo(() => {
    const paths = new Set<string>(['']);
    for (const folder of payload?.folders || []) paths.add(folder.path);
    for (const crumb of payload?.breadcrumb || []) if (crumb.path) paths.add(crumb.path);
    return [...paths]
      .filter((path) => !isGeneratedOutput(path))
      .sort()
      .map((path) => ({ label: path || 'Biblioteca (raiz)', value: path }));
  }, [payload]);
}

function ItemDialog({
  dialog,
  busy,
  folderOptions,
  onCancel,
  onSubmit,
}: {
  dialog: Dialog;
  busy: boolean;
  folderOptions: Array<{ label: string; value: string }>;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(dialog.value);
  const title =
    dialog.kind === 'new-folder'
      ? 'Nova pasta'
      : dialog.kind === 'rename'
        ? `Mudar o nome de “${dialog.row.name}”`
        : `Mover “${dialog.row.name}” para`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-6">
      <div className="ui-panel w-full max-w-md rounded-xl p-6">
        <h2 className="m-0 mb-4 font-heading text-lg font-semibold text-ink0">{title}</h2>
        {dialog.kind === 'move' ? (
          <select
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="ui-input w-full rounded-md px-3 py-2 text-base"
          >
            {folderOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && value.trim() && onSubmit(value)}
            className="ui-input w-full rounded-md px-3 py-2 text-base"
          />
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="ui-btn-secondary rounded-md px-3.5 py-1.5 text-base">
            Cancelar
          </button>
          <button
            type="button"
            disabled={busy || (dialog.kind !== 'move' && !value.trim())}
            onClick={() => onSubmit(value)}
            className="ui-btn-primary rounded-md px-4 py-1.5 text-base disabled:opacity-50"
          >
            {busy ? 'A guardar…' : 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  );
}
