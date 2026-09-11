import { documentKind, type DocumentKind } from '@/lib/library-layout';
import { getDb } from '@/lib/server/db';
import { notAppManagedSql, seedLocalFolders } from '@/lib/server/repo/library';
import { editableTemplateIdForFilename, isTemplateEditedForFilename } from '@/lib/server/repo/templates';
import { clientDocumentState, type ClientDocumentState, type DocumentState } from '@/lib/types';

// One folder of the Library, the way OneDrive serves one: the folders in it, a page of the
// files in it, and the breadcrumb to get back out.
//
// This replaces an endpoint that returned EVERY document in the library on every page load —
// four times per user journey, once of them by a screen that never rendered the result.

export type ListSortKey = 'name' | 'type' | 'modified' | 'size' | 'state';
export type ListSortDir = 'asc' | 'desc';

/** Sort columns come from this map, never from the request — the value is a column name. */
const SORT_COLUMNS: Record<ListSortKey, string> = {
  name: 'fold(d.name)',
  type: 'fold(d.doc_type)',
  modified: 'd.drive_modified_at',
  size: 'd.size',
  // Ordered by how far the document got, not alphabetically by an English identifier the
  // user never sees — otherwise the column sorts Erro, Indexado, Recebido.
  state: "CASE d.state WHEN 'failed' THEN 0 WHEN 'listed' THEN 1 WHEN 'downloaded' THEN 1 WHEN 'processing' THEN 2 ELSE 3 END",
};

export type ListFolderRow = {
  folderId: string;
  name: string;
  path: string;
  /** Files anywhere beneath this folder — OneDrive's "N items" column. */
  itemCount: number;
  /** How many of those still need processing, so a folder can carry a status too. */
  pendingCount: number;
  modifiedAt: number;
  isStructural: boolean;
};

export type ListFileRow = {
  documentId: string;
  name: string;
  title: string;
  path: string;
  docType: string;
  sourceKind: string;
  mime: string;
  size: number;
  modifiedAt: number;
  state: DocumentState;
  /** §6's state, in the client's own vocabulary. Derived here so no screen derives it. */
  clientState: ClientDocumentState;
  stateDetail: string;
  ocrPendingPages: number;
  pageCount: number;
  documentKind: DocumentKind;
  /** Set when this file is a template's published copy, so the list can offer its editor. */
  templateId: string;
  /** A generated output's conversion state — empty when nothing links this file to one. */
  outputState: string;
  /** A template's only state: whether the client has changed it. */
  templateEdited: boolean;
};

export type LibraryListResult = {
  path: string;
  breadcrumb: Array<{ name: string; path: string }>;
  folders: ListFolderRow[];
  files: ListFileRow[];
  nextCursor: string;
  totals: { folders: number; files: number };
};

export type LibraryListOptions = {
  path?: string;
  sort?: ListSortKey;
  dir?: ListSortDir;
  /** Name filter. Files match name or title; folders match name. Accent-insensitive. */
  q?: string;
  /** Look through every subfolder rather than just this one. */
  recursive?: boolean;
  cursor?: string;
  limit?: number;
};

type Cursor = { k: string | number; id: string };

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    return typeof parsed?.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** Escape a value used as a LIKE prefix — `_` and `%` are wildcards. */
function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function libraryList(options: LibraryListOptions = {}): LibraryListResult {
  const db = getDb();
  // A local-only install has nothing writing the folder table — no sync will ever run — so
  // without this the Library shows no folders at all, not even the app's own three.
  const noFolders = (db.prepare('SELECT COUNT(*) AS n FROM drive_folders').get() as { n: number }).n === 0;
  if (noFolders) seedLocalFolders();
  const folder = String(options.path || '').replace(/^\/+|\/+$/g, '');
  const sort: ListSortKey = SORT_COLUMNS[options.sort as ListSortKey] ? (options.sort as ListSortKey) : 'name';
  const dir: ListSortDir = options.dir === 'desc' ? 'desc' : 'asc';
  const query = String(options.q || '').trim();
  const recursive = Boolean(options.recursive) || query.length > 0;
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);

  const prefix = folder ? `${likeEscape(folder)}/%` : '%';
  const inScope = folder
    ? { sql: `(d.path = ? OR d.path LIKE ? ESCAPE '\\')`, params: [folder, prefix] }
    : { sql: '1 = 1', params: [] as string[] };
  const here = { sql: 'd.path = ?', params: [folder] };
  const scope = recursive ? inScope : here;

  // --- folders ---------------------------------------------------------------
  // Never paginated: a folder holds tens of subfolders, not thousands, and paginating them
  // alongside files would break the "folders always first" ordering across pages.
  const folderRows = db
    .prepare(
      `SELECT folder_id, name, path, drive_modified_at
         FROM drive_folders
        WHERE removed = 0
          AND ${folder ? "path LIKE ? ESCAPE '\\'" : "path <> ''"}
          ${query ? 'AND fold(name) LIKE ?' : ''}
        ORDER BY fold(name)`,
    )
    .all(
      ...(folder ? [`${likeEscape(folder)}/%`] : []),
      ...(query ? [`%${likeEscape(foldForSql(query))}%`] : []),
    ) as Array<{ folder_id: string; name: string; path: string; drive_modified_at: number }>;

  // Only DIRECT children of the browsed folder, unless we are filtering across everything.
  const directFolders = folderRows.filter((row) => {
    if (query) return true;
    if (!folder) return !row.path.includes('/');
    const rest = row.path.slice(folder.length + 1);
    return rest.length > 0 && !rest.includes('/');
  });

  const counts = folderCounts(db);
  const folders: ListFolderRow[] = directFolders.map((row) => ({
    folderId: row.folder_id,
    name: row.name,
    path: row.path,
    itemCount: counts.get(row.path)?.total || 0,
    pendingCount: counts.get(row.path)?.pending || 0,
    modifiedAt: row.drive_modified_at || 0,
    isStructural: false,
  }));

  // --- files -----------------------------------------------------------------
  const filters: string[] = ['d.removed = 0', scope.sql];
  const params: Array<string | number> = [...scope.params];
  if (query) {
    filters.push('(fold(d.name) LIKE ? OR fold(d.title) LIKE ?)');
    const needle = `%${likeEscape(foldForSql(query))}%`;
    params.push(needle, needle);
  }

  // The total describes the FOLDER, not the page — so it is counted before the cursor
  // narrows anything. Counting after it made the total shrink as the reader scrolled.
  const baseFilters = [...filters];
  const baseParams = [...params];

  const column = SORT_COLUMNS[sort];
  const cursor = decodeCursor(String(options.cursor || ''));
  if (cursor) {
    // Keyset, not OFFSET: a sync inserting rows mid-scroll must not shift the page under
    // the reader or make a row appear twice.
    const comparison = dir === 'asc' ? '>' : '<';
    filters.push(`(${column} ${comparison} ? OR (${column} = ? AND d.document_id ${comparison} ?))`);
    params.push(cursor.k, cursor.k, cursor.id);
  }

  const rows = db
    .prepare(
      `SELECT d.*, ${column} AS sort_key,
              (SELECT COUNT(*) FROM document_pages p WHERE p.document_id = d.document_id AND p.pending_ocr = 1) AS ocr_pending_pages
         FROM documents d
        WHERE ${filters.join(' AND ')}
        ORDER BY ${column} ${dir}, d.document_id ${dir}
        LIMIT ?`,
    )
    .all(...params, limit + 1) as Array<Record<string, unknown>>;

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor({ k: (last.sort_key as string | number) ?? '', id: String(last.document_id) })
      : '';

  const totals = db
    .prepare(`SELECT COUNT(*) AS n FROM documents d WHERE ${baseFilters.join(' AND ')}`)
    .get(...baseParams) as { n: number };

  return {
    path: folder,
    breadcrumb: breadcrumbFor(folder),
    folders,
    files: withOwnedState(page.map(toFileRow)),
    nextCursor,
    totals: { folders: folders.length, files: Number(totals.n) },
  };
}

/** The SQL `fold()` is the app's own folding, so the needle has to be folded the same way. */
function foldForSql(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function breadcrumbFor(folder: string): Array<{ name: string; path: string }> {
  const crumbs = [{ name: 'Biblioteca', path: '' }];
  if (!folder) return crumbs;
  const segments = folder.split('/').filter(Boolean);
  segments.forEach((segment, index) => {
    crumbs.push({ name: segment, path: segments.slice(0, index + 1).join('/') });
  });
  return crumbs;
}

/** Files beneath each folder, and how many of them still need work. One pass, not one per row. */
function folderCounts(db: ReturnType<typeof getDb>): Map<string, { total: number; pending: number }> {
  const notAppManaged = notAppManagedSql();
  const rows = db
    .prepare(
      `SELECT d.path AS path,
              COUNT(*) AS total,
              SUM(CASE WHEN ${notAppManaged.sql} AND (
                     d.state = 'listed' OR d.state = 'failed'
                     OR EXISTS (SELECT 1 FROM document_pages p WHERE p.document_id = d.document_id AND p.pending_ocr = 1)
                   ) THEN 1 ELSE 0 END) AS pending
         FROM documents d
        WHERE d.removed = 0 AND d.path <> ''
        GROUP BY d.path`,
    )
    .all(...notAppManaged.params) as Array<{ path: string; total: number; pending: number }>;

  // Roll each path up into every ancestor, so a folder counts what is anywhere beneath it.
  const counts = new Map<string, { total: number; pending: number }>();
  for (const row of rows) {
    const segments = row.path.split('/').filter(Boolean);
    for (let i = 0; i < segments.length; i += 1) {
      const key = segments.slice(0, i + 1).join('/');
      const current = counts.get(key) || { total: 0, pending: 0 };
      current.total += Number(row.total);
      current.pending += Number(row.pending);
      counts.set(key, current);
    }
  }
  return counts;
}

function toFileRow(row: Record<string, unknown>): ListFileRow {
  const path = String(row.path || '');
  const kind = documentKind(path);
  return {
    documentId: String(row.document_id),
    name: String(row.name || ''),
    title: String(row.title || ''),
    path,
    docType: String(row.doc_type || ''),
    sourceKind: String(row.source_kind || ''),
    mime: String(row.mime || ''),
    size: Number(row.size || 0),
    modifiedAt: Number(row.drive_modified_at || 0),
    state: row.state as DocumentState,
    clientState: clientDocumentState({
      state: String(row.state || ''),
      stage: String(row.stage || ''),
      removed: Number(row.removed || 0),
      missing: Number(row.missing || 0),
      ocrPendingPages: Number(row.ocr_pending_pages || 0),
    }),
    stateDetail: String(row.state_detail || ''),
    ocrPendingPages: Number(row.ocr_pending_pages || 0),
    pageCount: Number(row.page_count || 0),
    documentKind: kind,
    templateId: kind === 'template' ? editableTemplateIdForFilename(String(row.name || '')) : '',
    outputState: '',
    templateEdited: kind === 'template' && isTemplateEditedForFilename(String(row.name || '')),
  };
}

/**
 * Fill in the state the app's OWN files report — the two kinds that have no processing state.
 *
 * A generated file's state is its conversion's, reached through the drive item id the upload
 * recorded: one query for the page rather than one per row. A file with no conversion behind
 * it (the extracted-data record) keeps an empty state rather than borrowing its sibling's,
 * since nobody approved it.
 */
function withOwnedState(files: ListFileRow[]): ListFileRow[] {
  const ids = files.filter((f) => f.documentKind === 'generated').map((f) => f.documentId);
  if (ids.length === 0) return files;
  const holes = ids.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT d.document_id, c.state
         FROM conversions c
         JOIN documents d ON d.drive_item_id IN (c.onedrive_docx_id, c.onedrive_pdf_id)
        WHERE d.document_id IN (${holes})`,
    )
    .all(...ids) as Array<Record<string, unknown>>;
  const byDocument = new Map(rows.map((r) => [String(r.document_id), String(r.state || '')]));
  for (const file of files) file.outputState = byDocument.get(file.documentId) || '';
  return files;
}
