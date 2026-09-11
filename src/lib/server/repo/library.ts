import { existsSync, readFileSync } from 'node:fs';

import { GENERATED_FOLDER_ALIASES, LIBRARY_FOLDERS, STRUCTURAL_FOLDERS } from '@/lib/library-layout';
import { deleteSetting, deleteSettingsWithPrefix, getDb, getSetting, setSetting } from '@/lib/server/db';
import { genId } from '@/lib/server/crypto';
import { ensureLibraryStructure, uploadToLibrary } from '@/lib/server/graph-files';
import { originalPath } from '@/lib/server/ingest/store';
import { correctedFields } from '@/lib/server/repo/document-metadata';
import {
  deltaPage,
  driveId,
  folderAbsolutePath,
  isLibraryConfigured,
  libraryFolderId as graphLibraryFolderId,
  type DeltaItem,
} from '@/lib/server/msgraph';
import { clientDocumentState, type ClientDocumentState, type DocumentState } from '@/lib/types';

// The OneDrive library mirror: delta sync + document rows. The delta feed is the single
// source of truth for WHAT exists; the pipeline states (phase 2) describe what the app has
// done with each file. deltaLink is persisted so every sync after the first is incremental.

/**
 * Documents the APP manages rather than reads: its own outputs and the Word templates.
 * They sync back like any other file, but running them through ingestion would ask Graph to
 * convert a JSON to PDF (one permanent failed row per analysis) and would spend a
 * conversion, an OCR pass and a classification call on a stencil.
 */
const APP_MANAGED_FOLDERS = [LIBRARY_FOLDERS.templates, ...GENERATED_FOLDER_ALIASES];

/**
 * Escape a string used as a LIKE prefix. `_` matches any single character in LIKE, and our
 * own folder names contain no underscores today — but a client's do, and folder names are
 * about to become renameable.
 */
function likePrefix(folder: string): string {
  return `${folder.replace(/[\\%_]/g, '\\$&')}/%`;
}

/**
 * The "not one of the app's own files" filter, as SQL plus its parameters.
 *
 * Bound rather than interpolated: this used to build the folder names straight into the
 * query text, which was safe only for as long as they were constants — and this work makes
 * them user-renameable.
 */
export function notAppManagedSql(alias = 'd'): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  for (const folder of APP_MANAGED_FOLDERS) {
    clauses.push(`${alias}.path = ? OR ${alias}.path LIKE ? ESCAPE '\\'`);
    params.push(folder, likePrefix(folder));
  }
  return { sql: `NOT (${clauses.join(' OR ')})`, params };
}

export type DocumentRow = {
  documentId: string;
  driveItemId: string;
  name: string;
  path: string;
  mime: string;
  size: number;
  webUrl: string;
  state: DocumentState;
  /** §6's state, in the client's own vocabulary. Derived here so no screen derives it. */
  clientState: ClientDocumentState;
  stateDetail: string;
  removed: boolean;
  driveModifiedAt: number;
  syncedAt: number;
  docType: string;
  title: string;
  pageCount: number;
  // Pages still awaiting OCR — drives the "Indexado com alerta de OCR" presentation.
  ocrPendingPages: number;
  /** Set when this document came out of another one — an e-mail's attachment. */
  parentDocumentId: string;
  /** What the app decided this file is, once it read it. See @/lib/ingest-types. */
  sourceKind: string;
};

export type DocumentDetail = DocumentRow & {
  sha256: string;
  subject: string;
  issuedDate: string;
  effectiveDate: string;
  language: string;
  entity: string;
  groupArea: string;
  versionLabel: string;
  extractorVersion: string;
  ocrQuality: string;
  topics: string[];
  subtopics: string[];
  references: Array<{ text: string; citation: { document_id: string; page: number; excerpt: string } }>;
  classifiedAt: number;
  expiryDate: string;
  approvalStatus: string;
  /** §7.5: what the layout reader found in the page geometry. Counts, not the structure. */
  structure: DocumentStructureSummary;
  legislation: string[];
  obligations: string[];
  deadlines: string[];
  /** Which of these fields carry a human answer rather than the classifier's (§8). */
  correctedFields: string[];
};

type DbDocumentRow = {
  document_id: string;
  drive_item_id: string;
  name: string;
  path: string;
  mime: string;
  size: number;
  web_url: string;
  state: DocumentState;
  stage: string;
  state_detail: string;
  removed: number;
  missing: number;
  drive_modified_at: number;
  synced_at: number;
  doc_type: string;
  title: string;
  page_count: number;
  sha256: string;
  subject: string;
  issued_date: string;
  effective_date: string;
  language: string;
  entity: string;
  group_area: string;
  version_label: string;
  extractor_version: string;
  ocr_quality: string;
  topics_json: string;
  subtopics_json: string;
  references_json: string;
  classified_at: number;
  expiry_date: string;
  approval_status: string;
  structure_json: string;
  legislation_json: string;
  obligations_json: string;
  deadlines_json: string;
  ocr_pending_pages?: number;
  parent_document_id?: string;
  source_kind?: string;
};

function toRow(row: DbDocumentRow): DocumentRow {
  return {
    documentId: row.document_id,
    driveItemId: row.drive_item_id,
    name: row.name,
    path: row.path,
    mime: row.mime,
    size: row.size,
    webUrl: row.web_url,
    state: row.state,
    clientState: clientDocumentState({
      state: row.state,
      stage: row.stage,
      removed: row.removed,
      missing: row.missing,
      ocrPendingPages: Number(row.ocr_pending_pages || 0),
    }),
    stateDetail: row.state_detail,
    removed: Boolean(row.removed),
    driveModifiedAt: row.drive_modified_at,
    syncedAt: row.synced_at,
    docType: row.doc_type,
    title: row.title,
    pageCount: row.page_count,
    ocrPendingPages: Number(row.ocr_pending_pages || 0),
    parentDocumentId: row.parent_document_id || '',
    sourceKind: row.source_kind || '',
  };
}

export type DocumentStructureSummary = {
  headings: number;
  lists: number;
  tables: number;
  tableConfidence: 'n/a' | 'baixa';
};

function parseStructure(raw: string): DocumentStructureSummary {
  const empty: DocumentStructureSummary = { headings: 0, lists: 0, tables: 0, tableConfidence: 'n/a' };
  try {
    const parsed = JSON.parse(raw || '{}') as Partial<DocumentStructureSummary>;
    return {
      headings: Number(parsed.headings || 0),
      lists: Number(parsed.lists || 0),
      tables: Number(parsed.tables || 0),
      tableConfidence: parsed.tableConfidence === 'baixa' ? 'baixa' : 'n/a',
    };
  } catch {
    return empty;
  }
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function getDocumentDetail(documentId: string): DocumentDetail | null {
  const row = getDb()
    .prepare(
      `SELECT d.*, (SELECT COUNT(*) FROM document_pages p WHERE p.document_id = d.document_id AND p.pending_ocr = 1) AS ocr_pending_pages
       FROM documents d WHERE d.document_id = ?`,
    )
    .get(documentId) as DbDocumentRow | undefined;
  if (!row) return null;
  return {
    ...toRow(row),
    sha256: row.sha256,
    subject: row.subject,
    issuedDate: row.issued_date,
    effectiveDate: row.effective_date,
    language: row.language,
    entity: row.entity,
    groupArea: row.group_area,
    versionLabel: row.version_label,
    extractorVersion: row.extractor_version,
    ocrQuality: row.ocr_quality,
    topics: parseJsonArray<string>(row.topics_json),
    subtopics: parseJsonArray<string>(row.subtopics_json),
    references: parseJsonArray<DocumentDetail['references'][number]>(row.references_json),
    classifiedAt: row.classified_at,
    expiryDate: row.expiry_date,
    approvalStatus: row.approval_status,
    structure: parseStructure(row.structure_json),
    legislation: parseJsonArray<string>(row.legislation_json),
    obligations: parseJsonArray<string>(row.obligations_json),
    deadlines: parseJsonArray<string>(row.deadlines_json),
    correctedFields: correctedFields(documentId),
  };
}

// Documents under the app's own output folder are OUTPUTS, not client source material:
// they sync back like any file, but must never be treated as sources — that is what
// produced "potentially affected" warnings caused by an analysis's own PDF referencing its
// own main document. The folder names themselves live in @/lib/library-layout.
export { isGeneratedOutput, isTemplateFolder } from '@/lib/library-layout';

export function listDocuments(options?: { includeRemoved?: boolean }): DocumentRow[] {
  const where = options?.includeRemoved ? '' : 'WHERE removed = 0';
  const rows = getDb()
    .prepare(
      `SELECT d.*, (SELECT COUNT(*) FROM document_pages p WHERE p.document_id = d.document_id AND p.pending_ocr = 1) AS ocr_pending_pages
       FROM documents d ${where.replace('removed', 'd.removed')} ORDER BY d.path, d.name`,
    )
    .all() as DbDocumentRow[];
  return rows.map(toRow);
}

export function getDocument(documentId: string): DocumentRow | null {
  const row = getDb().prepare('SELECT * FROM documents WHERE document_id = ?').get(documentId) as
    | DbDocumentRow
    | undefined;
  return row ? toRow(row) : null;
}

/**
 * The folder a delta item lives in, relative to the library root ('' = directly inside it).
 *
 * Resolution is a chain, and the last link is the important one. An INCREMENTAL delta returns
 * a changed file WITHOUT re-listing its parents, so the in-memory map is empty — and the old
 * code then fell back to `''`, silently re-filing the document at the library root. For a
 * generated PDF that meant it stopped being recognised as this app's own output and re-entered
 * the pool of citable source material; for a client file it meant it vanished from the folder
 * they put it in. **Never guess the root.** A path we cannot resolve is a path we skip.
 *
 * Returns `null` when the item should be deferred to a later sync rather than re-filed.
 */
function relativePath(item: DeltaItem, libraryFolderId: string, folderPaths: Map<string, string>): string | null {
  const parentId = String(item.parentReference?.id || '');
  if (!parentId || parentId === libraryFolderId) return '';

  // 1) Learned from a folder item earlier in this same delta pass.
  const known = folderPaths.get(parentId);
  if (known !== undefined) return known;

  // 2) Learned by a previous pass and persisted.
  const row = getDb().prepare('SELECT path FROM drive_folders WHERE folder_id = ?').get(parentId) as
    | { path: string }
    | undefined;
  if (row) return row.path;

  // 3) The item carries its own parent path — "/drive/root:/Legal/Biblioteca/Sub". Everything
  // after the library folder's own path is ours. Free, offline, and it covers the ordinary
  // incremental case where the parent simply was not in this page.
  const fromParentPath = pathFromParentReference(String(item.parentReference?.path || ''));
  if (fromParentPath !== null) {
    folderPaths.set(parentId, fromParentPath);
    return fromParentPath;
  }

  // 4) Unknown. Leave the row exactly as it is and try again next pass.
  return null;
}

/**
 * Turn a Graph `parentReference.path` into a path relative to the library folder, using the
 * library folder's own absolute path recorded when it was chosen. Returns null when the
 * prefix is unknown or the item is outside the library.
 */
function pathFromParentReference(parentPath: string): string | null {
  if (!parentPath) return null;
  const libraryPath = String(getSetting('graph.library_folder_path') || '');
  if (!libraryPath) return null;
  if (parentPath === libraryPath) return '';
  const prefix = `${libraryPath}/`;
  if (!parentPath.startsWith(prefix)) return null;
  return parentPath.slice(prefix.length);
}

export type FolderRow = { folderId: string; parentId: string; name: string; path: string };

/**
 * Mark everything inside a deleted folder as removed, and return how many documents that was.
 * Reads the folder's own path first, so a folder whose row is already gone is a no-op.
 */
function cascadeFolderRemoval(db: ReturnType<typeof getDb>, folderId: string, now: number): number {
  const folder = db.prepare('SELECT path FROM drive_folders WHERE folder_id = ?').get(folderId) as
    | { path: string }
    | undefined;
  db.prepare('UPDATE drive_folders SET removed = 1, updated_at = ? WHERE folder_id = ?').run(now, folderId);
  if (!folder?.path) return 0;
  const prefix = `${folder.path.replace(/[\\%_]/g, '\\$&')}/%`;
  const docs = db
    .prepare(
      `UPDATE documents SET removed = 1, state_detail = 'Pasta eliminada no OneDrive.', updated_at = ?
       WHERE removed = 0 AND (path = ? OR path LIKE ? ESCAPE '\\')`,
    )
    .run(now, folder.path, prefix);
  db.prepare(
    `UPDATE drive_folders SET removed = 1, updated_at = ? WHERE removed = 0 AND path LIKE ? ESCAPE '\\'`,
  ).run(now, prefix);
  return Number(docs.changes);
}

/** Every folder the library has, so the UI can show one that holds no files yet. */
export function listFolders(): FolderRow[] {
  // A local-only install never syncs, so nothing else would ever write this table.
  const empty = (getDb().prepare('SELECT COUNT(*) AS n FROM drive_folders').get() as { n: number }).n === 0;
  if (empty) seedLocalFolders();
  const rows = getDb()
    .prepare('SELECT folder_id, parent_id, name, path FROM drive_folders WHERE removed = 0 ORDER BY path')
    .all() as Array<{ folder_id: string; parent_id: string; name: string; path: string }>;
  return rows.map((r) => ({ folderId: r.folder_id, parentId: r.parent_id, name: r.name, path: r.path }));
}

/**
 * A library that moved: a different root folder, or a different Microsoft account. The
 * documents the app knows about are still real — their bytes are in the local content store
 * — but the ids that located them in OneDrive are not valid where the library now is.
 */
export type PendingLibraryMove = {
  at: number;
  fromAccountEmail: string;
  fromFolderName: string;
  sameAccount: boolean;
  documentCount: number;
  transferableCount: number;
};

const PENDING_MOVE_KEY = 'graph.pending_transfer';

/**
 * The app's own Word stencils are not the client's documents. `ensureLibraryStructure()`
 * publishes a fresh copy into whatever library the app is pointed at, so carrying the old
 * rows across would leave two of each in the client's OneDrive.
 */
function retireMissingTemplateRows(): void {
  getDb()
    .prepare(
      `UPDATE documents SET removed = 1, updated_at = ?
       WHERE missing = 1 AND removed = 0 AND (path = ? OR path LIKE ? ESCAPE '\\')`,
    )
    .run(Date.now(), LIBRARY_FOLDERS.templates, likePrefix(LIBRARY_FOLDERS.templates));
}

/** Documents whose bytes the app still holds, and can therefore upload somewhere new. */
function transferableDocuments(): Array<{ documentId: string; name: string; path: string; sha256: string; mime: string }> {
  const rows = getDb()
    .prepare(
      `SELECT document_id, name, path, sha256, mime FROM documents
       WHERE removed = 0 AND missing = 1 AND sha256 <> '' ORDER BY path, name`,
    )
    .all() as Array<{ document_id: string; name: string; path: string; sha256: string; mime: string }>;
  return rows
    .filter((r) => existsSync(originalPath(r.sha256)))
    .map((r) => ({ documentId: r.document_id, name: r.name, path: r.path, sha256: r.sha256, mime: r.mime }));
}

/**
 * Record that the library moved and mark every document as missing. Nothing is deleted:
 * a missing document keeps its pages, citations and analyses, and comes back the moment its
 * file is somewhere the app can reach again.
 */
export function markLibraryMoved(previous: { accountEmail: string; folderName: string; sameAccount: boolean }): void {
  const db = getDb();
  const now = Date.now();
  db.prepare('UPDATE documents SET missing = 1, missing_since = ? WHERE removed = 0 AND missing = 0').run(now);
  retireMissingTemplateRows();
  const documentCount = (
    db.prepare('SELECT COUNT(*) AS n FROM documents WHERE removed = 0 AND missing = 1').get() as { n: number }
  ).n;
  if (documentCount === 0) {
    deleteSetting(PENDING_MOVE_KEY);
    return;
  }
  const move: PendingLibraryMove = {
    at: now,
    fromAccountEmail: previous.accountEmail,
    fromFolderName: previous.folderName,
    sameAccount: previous.sameAccount,
    documentCount,
    transferableCount: transferableDocuments().length,
  };
  setSetting(PENDING_MOVE_KEY, JSON.stringify(move));
}

/** The one decision a move leaves open: bring the documents across, or leave them behind. */
export function pendingLibraryMove(): PendingLibraryMove | null {
  const raw = String(getSetting(PENDING_MOVE_KEY) || '');
  if (!raw) return null;
  try {
    const move = JSON.parse(raw) as PendingLibraryMove;
    // Recounted on read: documents can have come back on their own through a sync.
    const documentCount = (
      getDb().prepare('SELECT COUNT(*) AS n FROM documents WHERE removed = 0 AND missing = 1').get() as { n: number }
    ).n;
    if (documentCount === 0) {
      deleteSetting(PENDING_MOVE_KEY);
      return null;
    }
    return { ...move, documentCount, transferableCount: transferableDocuments().length };
  } catch {
    deleteSetting(PENDING_MOVE_KEY);
    return null;
  }
}

export function dismissLibraryMove(): void {
  deleteSetting(PENDING_MOVE_KEY);
}

export type TransferReport = {
  transferred: number;
  stillMissing: number;
  failures: Array<{ name: string; reason: string }>;
};

/**
 * Upload every document the app still holds bytes for into the library where it now is.
 *
 * The bytes come from the local content store, never from the previous account: the app
 * does not need — and must not keep — a way back into somebody else's OneDrive.
 *
 * Failures are collected and returned together. One report for the whole transfer, not one
 * message per file: a move of a hundred documents that hits a recurring problem must say so
 * once.
 */
export async function transferLibrary(): Promise<TransferReport> {
  const db = getDb();
  const failures: TransferReport['failures'] = [];
  let transferred = 0;
  for (const doc of transferableDocuments()) {
    try {
      const bytes = readFileSync(originalPath(doc.sha256));
      const uploaded = await uploadToLibrary(doc.name, bytes, doc.path, doc.mime || 'application/octet-stream');
      db.prepare(
        `UPDATE documents SET drive_item_id = ?, web_url = ?, missing = 0, missing_since = 0, updated_at = ?
         WHERE document_id = ?`,
      ).run(uploaded.itemId, uploaded.webUrl, Date.now(), doc.documentId);
      transferred += 1;
    } catch (error) {
      failures.push({ name: [doc.path, doc.name].filter(Boolean).join('/'), reason: errorText(error) });
    }
  }
  const stillMissing = (
    db.prepare('SELECT COUNT(*) AS n FROM documents WHERE removed = 0 AND missing = 1').get() as { n: number }
  ).n;
  if (stillMissing === 0) deleteSetting(PENDING_MOVE_KEY);
  return { transferred, stillMissing, failures };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Forget everything the app cached ABOUT ONE DRIVE: folder ids, the structure guard, the
 * delta cursor and the mirrored folder rows. The library moving — a different root folder,
 * or a different Microsoft account — invalidates all of it at once. Left behind, these send
 * the app writing into a location it can no longer reach, which surfaces far away from the
 * cause as a bare HTTP 404.
 */
export function resetDriveScopedState(): void {
  deleteSettingsWithPrefix('graph.folder.');
  deleteSetting('graph.structure_ready');
  setSetting('graph.delta_link', '');
  getDb().prepare('DELETE FROM drive_folders').run();
}

/**
 * Called after a sign-in: if the connected account's drive is not the one the library was
 * chosen on, drop the library selection along with the rest of the drive-scoped cache. The
 * folder id belonged to the previous drive, so keeping it would leave the app "configured"
 * against a folder this account cannot open. Returns whether the drive changed.
 */
export async function forgetLibraryIfDriveChanged(previousAccountEmail: string): Promise<boolean> {
  const previous = String(getSetting('graph.drive_id') || '');
  const current = await driveId().catch(() => '');
  if (!current || current === previous) return false;
  const previousFolderName = String(getSetting('graph.library_folder_name') || '');
  resetDriveScopedState();
  setSetting('graph.drive_id', current);
  deleteSetting('graph.library_folder_id');
  deleteSetting('graph.library_folder_name');
  deleteSetting('graph.library_folder_path');
  // Only a library that HAD been chosen can have been left behind. The first connection of
  // a fresh install moves nothing.
  if (previous) {
    markLibraryMoved({
      accountEmail: previousAccountEmail,
      folderName: previousFolderName,
      sameAccount: false,
    });
  }
  return true;
}

/**
 * Create the folders the app expects, then publish the built-in templates into them. Safe
 * to call repeatedly; the underlying steps are each idempotent.
 */
export async function ensureLibraryReady(): Promise<{ created: string[]; skipped: boolean }> {
  const structure = await ensureLibraryStructure();
  // Folders exist locally whether or not OneDrive does. Without this, `drive_folders` was
  // only ever written by the delta sync, so on a local-only install it stayed empty and the
  // Library had to hard-code the three folder names into the UI to show anything at all.
  seedLocalFolders();
  // Unconditionally, NOT only when the structure was just created. `ensureLibraryStructure`
  // reports skipped once it has succeeded for a folder, so gating on it meant an established
  // install never republished a built-in template again — a correction to one could reach the
  // repo and never reach the client. Publishing decides for itself what needs writing.
  const { publishBuiltinTemplates } = await import('@/lib/server/repo/templates');
  await publishBuiltinTemplates();
  return structure;
}

/**
 * Make sure every folder the app knows about has a row: the structural ones, plus every
 * ancestor implied by a document's path. Folders learned this way get a `local-` id, which
 * the next delta upgrades to the real Graph id by matching on path.
 */
export function seedLocalFolders(): void {
  const db = getDb();
  const now = Date.now();
  const known = new Set(
    (db.prepare('SELECT path FROM drive_folders').all() as Array<{ path: string }>).map((r) => r.path),
  );

  const wanted = new Set<string>(STRUCTURAL_FOLDERS);
  const paths = db.prepare("SELECT DISTINCT path FROM documents WHERE removed = 0 AND path <> ''").all() as Array<{
    path: string;
  }>;
  for (const row of paths) {
    const segments = row.path.split('/').filter(Boolean);
    for (let i = 0; i < segments.length; i += 1) wanted.add(segments.slice(0, i + 1).join('/'));
  }

  const insert = db.prepare(
    `INSERT INTO drive_folders (folder_id, parent_id, name, path, removed, drive_modified_at, updated_at)
     VALUES (?, '', ?, ?, 0, 0, ?)
     ON CONFLICT(folder_id) DO NOTHING`,
  );
  for (const path of [...wanted].sort()) {
    if (known.has(path)) continue;
    const name = path.split('/').pop() || path;
    insert.run(`local-folder-${sha1Path(path)}`, name, path, now);
  }
}

/** A stable synthetic folder id derived from the path, so re-seeding is idempotent. */
function sha1Path(path: string): string {
  let hash = 0;
  for (let i = 0; i < path.length; i += 1) hash = (Math.imul(31, hash) + path.charCodeAt(i)) | 0;
  return `${(hash >>> 0).toString(36)}-${path.length}`;
}

export type SyncResult = {
  status: 'ok' | 'not_configured';
  upserted: number;
  removed: number;
  pending?: number;
  /** Items whose folder could not be resolved this pass. They are retried, never re-filed. */
  deferred?: number;
  detail: string;
};

let syncRunning = false;

/**
 * One delta-sync pass. Safe to call from anywhere (login, interval, Sync now) — it no-ops
 * when the library is not configured and refuses to overlap itself. Errors are recorded in
 * settings (surfaced in health + the Library page) and rethrown for interactive callers.
 */
export async function syncLibrary(): Promise<SyncResult> {
  if (!isLibraryConfigured()) {
    return { status: 'not_configured', upserted: 0, removed: 0, pending: 0, detail: 'Library is not configured.' };
  }
  if (syncRunning) {
    return { status: 'ok', upserted: 0, removed: 0, pending: 0, deferred: 0, detail: 'A sync is already running.' };
  }
  syncRunning = true;
  try {
    // An install that chose its library folder before relativePath needed the absolute path
    // backfills it here, once.
    if (!getSetting('graph.library_folder_path')) {
      const resolved = await folderAbsolutePath(graphLibraryFolderId()).catch(() => '');
      if (resolved) setSetting('graph.library_folder_path', resolved);
    }
    // Best-effort: an install configured before the folder structure existed gets it on its
    // next sync, without anyone having to press anything.
    await ensureLibraryReady().catch((error) => {
      console.warn('[legal] Could not ensure the library structure:', error instanceof Error ? error.message : error);
    });
    // Documents generated before the letterhead existed are rewritten where they stand.
    // Resumable and self-marking, so it costs nothing once the library has caught up.
    const { backfillLetterheadInBackground } = await import('@/lib/server/repo/letterhead-backfill');
    backfillLetterheadInBackground();
    const db = getDb();
    const libraryFolderId = graphLibraryFolderId();
    const now = Date.now();
    let upserted = 0;
    let removedCount = 0;
    let deferred = 0;

    // Folder id -> relative path, learned from folder items in the feed (delta lists a
    // folder before its descendants on initial enumeration).
    const folderPaths = new Map<string, string>();

    let link = String(getSetting('graph.delta_link') || '') || libraryFolderId;
    let deltaLink = '';
    while (link) {
      const page = await deltaPage(link);
      for (const item of page.value) {
        if (item.deleted) {
          const res = db
            .prepare('UPDATE documents SET removed = 1, updated_at = ? WHERE drive_item_id = ?')
            .run(now, item.id);
          if (Number(res.changes) > 0) removedCount += 1;
          // A deleted FOLDER takes its contents with it. Graph usually emits a delete per
          // descendant, but nothing here relied on that or reconciled when it did not — so a
          // deleted folder could leave live document rows pointing into a folder that no
          // longer exists.
          removedCount += cascadeFolderRemoval(db, item.id, now);
          continue;
        }
        if (item.folder) {
          if (item.id !== libraryFolderId) {
            const parentPath = relativePath(item, libraryFolderId, folderPaths);
            if (parentPath === null) {
              deferred += 1;
              continue;
            }
            const folderPath = parentPath ? `${parentPath}/${item.name}` : String(item.name || '');
            folderPaths.set(item.id, folderPath);
            // Persisted, not merely remembered: the map dies with this pass, but the next
            // incremental delta still needs to know where this folder is.
            // A folder seeded locally (before OneDrive was connected, or from a document's
            // path) is the SAME folder the delta is now reporting with its real Graph id.
            // Without this the two coexist and the Library shows every folder twice.
            db.prepare('DELETE FROM drive_folders WHERE path = ? AND folder_id <> ?').run(folderPath, item.id);
            db.prepare(
              `INSERT INTO drive_folders (folder_id, parent_id, name, path, removed, drive_modified_at, updated_at)
               VALUES (?, ?, ?, ?, 0, ?, ?)
               ON CONFLICT(folder_id) DO UPDATE SET
                 parent_id = excluded.parent_id, name = excluded.name,
                 path = excluded.path, removed = 0, updated_at = excluded.updated_at,
                 drive_modified_at = excluded.drive_modified_at`,
            ).run(
              item.id,
              String(item.parentReference?.id || ''),
              String(item.name || ''),
              folderPath,
              Date.parse(String(item.lastModifiedDateTime || '')) || 0,
              now,
            );
          }
          continue;
        }
        if (!item.file) continue;

        const path = relativePath(item, libraryFolderId, folderPaths);
        if (path === null) {
          // Its folder is not known yet. Leaving the row untouched is the whole point: the
          // alternative was filing it at the root and quietly moving the user's document.
          deferred += 1;
          continue;
        }
        const existing = db
          .prepare('SELECT document_id, ctag, sha256 FROM documents WHERE drive_item_id = ?')
          .get(item.id) as { document_id: string; ctag: string; sha256: string } | undefined;
        const modifiedAt = Date.parse(String(item.lastModifiedDateTime || '')) || 0;

        if (!existing) {
          // A file the app already knows, arriving under a new id: the library moved and this
          // one has been put back. Adopt the ROW rather than inserting a second document —
          // its pages, citations and analyses are all attached to it, and an analysis that
          // was archived because this file was gone becomes readable again by itself.
          const returning = db
            .prepare(
              `SELECT document_id FROM documents
               WHERE missing = 1 AND removed = 0 AND name = ? AND path = ? AND size = ?
               ORDER BY missing_since LIMIT 1`,
            )
            .get(String(item.name || ''), path, Number(item.size || 0)) as { document_id: string } | undefined;
          if (returning) {
            db.prepare(
              `UPDATE documents SET drive_item_id = ?, etag = ?, ctag = ?, web_url = ?, drive_modified_at = ?,
                                    missing = 0, missing_since = 0, synced_at = ?, updated_at = ?
               WHERE document_id = ?`,
            ).run(
              item.id,
              String(item.eTag || ''),
              String(item.cTag || ''),
              String(item.webUrl || ''),
              modifiedAt,
              now,
              now,
              returning.document_id,
            );
            upserted += 1;
            continue;
          }
          db.prepare(
            `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, etag, ctag,
                                    web_url, drive_modified_at, state, removed, synced_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'listed', 0, ?, ?, ?)`,
          ).run(
            genId('doc'),
            item.id,
            String(item.name || ''),
            path,
            String(item.file.mimeType || ''),
            Number(item.size || 0),
            String(item.eTag || ''),
            String(item.cTag || ''),
            String(item.webUrl || ''),
            modifiedAt,
            now,
            now,
            now,
          );
          upserted += 1;
          continue;
        }

        // Content change (cTag moves only when the file BODY changes; renames keep it).
        // A previously ingested document goes back to 'listed' so phase 2 re-processes it.
        const contentChanged = String(item.cTag || '') !== existing.ctag && existing.sha256 !== '';
        db.prepare(
          `UPDATE documents SET name = ?, path = ?, mime = ?, size = ?, etag = ?, ctag = ?, web_url = ?,
                                drive_modified_at = ?, removed = 0, missing = 0, missing_since = 0,
                                synced_at = ?, updated_at = ?
                                ${contentChanged ? `, state = 'listed', stage = 'recebido', sha256 = '', state_detail = 'Content changed on OneDrive — awaiting re-processing.'` : ''}
           WHERE drive_item_id = ?`,
        ).run(
          String(item.name || ''),
          path,
          String(item.file.mimeType || ''),
          Number(item.size || 0),
          String(item.eTag || ''),
          String(item.cTag || ''),
          String(item.webUrl || ''),
          modifiedAt,
          now,
          now,
          item.id,
        );
        upserted += 1;
      }
      deltaLink = page['@odata.deltaLink'] || '';
      link = page['@odata.nextLink'] || '';
    }

    if (deltaLink) setSetting('graph.delta_link', deltaLink);
    setSetting('graph.last_sync_at', String(now));
    setSetting('graph.last_sync_status', 'ok');
    // Process everything still unprocessed — what this pass just listed AND anything left
    // pending from before (sequential, background, hash-cached so nothing is paid twice).
    const notAppManaged = notAppManagedSql();
    const pending = Number(
      (db
        .prepare(
          `SELECT COUNT(*) AS n FROM documents d WHERE d.removed = 0 AND ${notAppManaged.sql} AND (
             d.state = 'listed'
             OR EXISTS (SELECT 1 FROM document_pages p WHERE p.document_id = d.document_id AND p.pending_ocr = 1)
           )`,
        )
        .get(...notAppManaged.params) as { n: number }).n,
    );
    // The sweep also redoes documents carrying an older classification, and those are not
    // `pending` — they are indexed, and counting them here would report finished work as
    // outstanding. But the decision to RUN the sweep has to see them, or a backfill stalls
    // the moment nothing else happens to be pending and never resumes.
    const { CLASSIFIER_VERSION, ingestPendingInBackground } = await import('@/lib/server/ingest/pipeline');
    const staleClassifications = Number(
      (db
        .prepare(
          `SELECT COUNT(*) AS n FROM documents d WHERE d.removed = 0 AND ${notAppManaged.sql}
             AND d.state = 'indexed' AND d.classifier_version <> ?`,
        )
        .get(...notAppManaged.params, CLASSIFIER_VERSION) as { n: number }).n,
    );
    if (pending > 0 || staleClassifications > 0) ingestPendingInBackground();
    // Templates the client added arrive through the same delta feed as everything else.
    const { refreshLibraryTemplates } = await import('@/lib/server/repo/templates');
    void refreshLibraryTemplates().catch((error) => {
      console.warn('[legal] Could not refresh library templates:', error instanceof Error ? error.message : error);
    });
    return { status: 'ok', upserted, removed: removedCount, pending, deferred, detail: '' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setSetting('graph.last_sync_status', message.slice(0, 300));
    throw error;
  } finally {
    syncRunning = false;
  }
}

export function lastSync(): { at: number; status: string } {
  return {
    at: Number(getSetting('graph.last_sync_at') || 0),
    status: String(getSetting('graph.last_sync_status') || ''),
  };
}

/** Fire-and-forget sync for non-interactive triggers (login, interval). Never throws. */
export function syncLibraryInBackground(reason: string): void {
  void syncLibrary().catch((error) => {
    console.warn(`[legal] Library sync (${reason}) failed:`, error instanceof Error ? error.message : error);
  });
}
