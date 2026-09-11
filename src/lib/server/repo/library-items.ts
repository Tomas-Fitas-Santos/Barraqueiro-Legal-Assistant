import { ApiError } from '@/app/api/_helpers';
import {
  isGeneratedOutput,
  isStructuralFolder,
  isTemplateFolder,
  LIBRARY_FOLDERS,
  validateItemName,
} from '@/lib/library-layout';
import { getDb } from '@/lib/server/db';
import { ensureFolderPath } from '@/lib/server/graph-files';
import {
  createChildFolder,
  deleteItem,
  isLibraryConfigured,
  libraryFolderId,
  patchItem,
} from '@/lib/server/msgraph';

// Creating, renaming, moving and deleting things in the client's library.
//
// Every operation is "the drive first, then the local mirror in one transaction". That order
// matters: if the drive refuses, nothing local changed and the user sees why; if the mirror
// write failed after the drive succeeded, the next sync repairs it. The reverse order would
// leave the app confidently showing a state the drive never accepted.
//
// All of it also works with no OneDrive at all — a local-only install is a supported way to
// run this app, and every result says whether the drive saw the change.

export type ItemRef = { kind: 'folder'; folderId: string } | { kind: 'file'; documentId: string };

export type ItemResult = {
  path: string;
  name: string;
  /** How many document rows had their path rewritten (a folder carries its subtree). */
  movedDocuments: number;
  syncedToDrive: boolean;
};

/** Escape a value used as a LIKE prefix — `_` and `%` are wildcards. */
function likePrefix(path: string): string {
  return `${path.replace(/[\\%_]/g, '\\$&')}/%`;
}

function parentOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

function join(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

type FolderRecord = { folder_id: string; name: string; path: string };
type FileRecord = { document_id: string; drive_item_id: string; name: string; path: string };

function folderById(folderId: string): FolderRecord {
  const row = getDb()
    .prepare('SELECT folder_id, name, path FROM drive_folders WHERE folder_id = ? AND removed = 0')
    .get(folderId) as FolderRecord | undefined;
  if (!row) throw new ApiError('Pasta não encontrada.', 404);
  return row;
}

function fileById(documentId: string): FileRecord {
  const row = getDb()
    .prepare('SELECT document_id, drive_item_id, name, path FROM documents WHERE document_id = ? AND removed = 0')
    .get(documentId) as FileRecord | undefined;
  if (!row) throw new ApiError('Documento não encontrado.', 404);
  return row;
}

/** Refuse to touch the folders the app recreates — the install would end up with two. */
function assertNotStructural(path: string): void {
  if (isStructuralFolder(path)) {
    throw new ApiError(
      `“${path}” é uma pasta da aplicação e não pode ser alterada. A estrutura é gerida em Definições.`,
      400,
    );
  }
}

export async function createFolder(parentPath: string, rawName: string): Promise<ItemResult> {
  const check = validateItemName(rawName);
  if (!check.ok) throw new ApiError(check.error, 400);
  const name = check.name;
  const path = join(parentPath, name);

  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM drive_folders WHERE path = ? AND removed = 0').get(path);
  if (exists) throw new ApiError('Já existe uma pasta com esse nome.', 409);

  let folderId = `local-folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let syncedToDrive = false;
  if (isLibraryConfigured()) {
    const parentId = parentPath ? await ensureFolderPath(parentPath) : libraryFolderId();
    const created = await createChildFolder(parentId, name);
    folderId = created.id;
    syncedToDrive = true;
  }

  db.prepare(
    `INSERT INTO drive_folders (folder_id, parent_id, name, path, removed, drive_modified_at, updated_at)
     VALUES (?, '', ?, ?, 0, ?, ?)`,
  ).run(folderId, name, path, Date.now(), Date.now());

  return { path, name, movedDocuments: 0, syncedToDrive };
}

export async function renameItem(ref: ItemRef, rawName: string): Promise<ItemResult> {
  const check = validateItemName(rawName);
  if (!check.ok) throw new ApiError(check.error, 400);
  const name = check.name;

  if (ref.kind === 'file') {
    const file = fileById(ref.documentId);
    // Changing the extension would silently invalidate the detected format, the stored PDF
    // rendition and every citation resolved through it. Refuse, and say why.
    if (extensionOf(name) !== extensionOf(file.name)) {
      throw new ApiError(
        'Não é possível mudar a extensão do ficheiro — isso invalidaria o texto extraído e as citações já feitas.',
        400,
      );
    }
    const syncedToDrive = await patchOnDrive(file.drive_item_id, { name });
    getDb()
      .prepare('UPDATE documents SET name = ?, updated_at = ? WHERE document_id = ?')
      .run(name, Date.now(), file.document_id);
    return { path: file.path, name, movedDocuments: 0, syncedToDrive };
  }

  const folder = folderById(ref.folderId);
  assertNotStructural(folder.path);
  const target = join(parentOf(folder.path), name);
  if (target === folder.path) return { path: folder.path, name, movedDocuments: 0, syncedToDrive: false };

  const syncedToDrive = await patchOnDrive(folder.folder_id, { name });
  const moved = rewriteSubtree(folder.path, target, name, folder.folder_id);
  return { path: target, name, movedDocuments: moved, syncedToDrive };
}

export async function moveItem(ref: ItemRef, targetFolderPath: string): Promise<ItemResult & { note: string }> {
  const destination = String(targetFolderPath || '').replace(/^\/+|\/+$/g, '');
  // The app's own outputs folder is app-owned. A client file living there would silently
  // stop being offered as source material for an analysis, with nothing to explain why.
  if (isGeneratedOutput(destination)) {
    throw new ApiError(
      `“${LIBRARY_FOLDERS.generated}” é a pasta dos documentos produzidos pela aplicação e não recebe ficheiros.`,
      400,
    );
  }

  if (ref.kind === 'file') {
    const file = fileById(ref.documentId);
    if (file.path === destination) return { path: destination, name: file.name, movedDocuments: 0, syncedToDrive: false, note: '' };
    const syncedToDrive = await patchOnDrive(file.drive_item_id, {
      parentId: destination ? await resolveFolderId(destination) : libraryFolderId(),
    });
    const note = reclassify(file.document_id, file.path, destination);
    getDb()
      .prepare('UPDATE documents SET path = ?, updated_at = ? WHERE document_id = ?')
      .run(destination, Date.now(), file.document_id);
    return { path: destination, name: file.name, movedDocuments: 1, syncedToDrive, note };
  }

  const folder = folderById(ref.folderId);
  assertNotStructural(folder.path);
  if (destination === folder.path || destination.startsWith(`${folder.path}/`)) {
    throw new ApiError('Não é possível mover uma pasta para dentro de si própria.', 400);
  }
  const target = join(destination, folder.name);
  const syncedToDrive = await patchOnDrive(folder.folder_id, {
    parentId: destination ? await resolveFolderId(destination) : libraryFolderId(),
  });
  const moved = rewriteSubtree(folder.path, target, folder.name, folder.folder_id);
  return { path: target, name: folder.name, movedDocuments: moved, syncedToDrive, note: '' };
}

export type FolderImpact = { documents: number; folders: number };

/** What a delete would take with it — Graph's folder delete is always recursive. */
export function folderImpact(folderPath: string): FolderImpact {
  const db = getDb();
  const prefix = likePrefix(folderPath);
  const documents = db
    .prepare(`SELECT COUNT(*) AS n FROM documents WHERE removed = 0 AND (path = ? OR path LIKE ? ESCAPE '\\')`)
    .get(folderPath, prefix) as { n: number };
  const folders = db
    .prepare(`SELECT COUNT(*) AS n FROM drive_folders WHERE removed = 0 AND path LIKE ? ESCAPE '\\'`)
    .get(prefix) as { n: number };
  return { documents: Number(documents.n), folders: Number(folders.n) };
}

export async function deleteFolder(folderId: string): Promise<{
  deletedOnDrive: boolean;
  documentsRemoved: number;
  foldersRemoved: number;
}> {
  const folder = folderById(folderId);
  assertNotStructural(folder.path);

  let deletedOnDrive = false;
  if (isLibraryConfigured() && !folder.folder_id.startsWith('local-')) {
    await deleteItem(folder.folder_id);
    deletedOnDrive = true;
  }

  const db = getDb();
  const now = Date.now();
  const prefix = likePrefix(folder.path);
  // Rows are flagged, never destroyed: an analysis that cited a document inside this folder
  // must still be able to resolve that citation.
  const documents = db
    .prepare(
      `UPDATE documents SET removed = 1, state_detail = 'Pasta eliminada pelo utilizador.', updated_at = ?
       WHERE removed = 0 AND (path = ? OR path LIKE ? ESCAPE '\\')`,
    )
    .run(now, folder.path, prefix);
  const folders = db
    .prepare(
      `UPDATE drive_folders SET removed = 1, updated_at = ?
       WHERE removed = 0 AND (folder_id = ? OR path LIKE ? ESCAPE '\\')`,
    )
    .run(now, folder.folder_id, prefix);

  return {
    deletedOnDrive,
    documentsRemoved: Number(documents.changes),
    foldersRemoved: Number(folders.changes),
  };
}

// --- helpers ---------------------------------------------------------------

function extensionOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at <= 0 ? '' : name.slice(at).toLowerCase();
}

async function patchOnDrive(driveItemId: string, changes: { name?: string; parentId?: string }): Promise<boolean> {
  // A local-only item, or no drive at all: the mirror is the whole truth here.
  if (!isLibraryConfigured() || !driveItemId || driveItemId.startsWith('local-')) return false;
  await patchItem(driveItemId, changes);
  return true;
}

async function resolveFolderId(path: string): Promise<string> {
  const row = getDb()
    .prepare('SELECT folder_id FROM drive_folders WHERE path = ? AND removed = 0')
    .get(path) as { folder_id: string } | undefined;
  if (row && !row.folder_id.startsWith('local-')) return row.folder_id;
  return ensureFolderPath(path);
}

/** Rewrite a folder and everything under it, in one transaction. */
function rewriteSubtree(from: string, to: string, name: string, folderId: string): number {
  const db = getDb();
  const now = Date.now();
  const prefix = likePrefix(from);
  // substr() is 1-based and the offset is "one past the old prefix", so the remainder keeps
  // its leading separator — `from/a/b` becomes `to` + `/a/b`.
  const offset = from.length + 1;

  let moved = 0;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE drive_folders SET name = ?, path = ?, updated_at = ? WHERE folder_id = ?').run(
      name,
      to,
      now,
      folderId,
    );
    db.prepare(
      `UPDATE drive_folders SET path = ? || substr(path, ?), updated_at = ?
       WHERE removed = 0 AND path LIKE ? ESCAPE '\\'`,
    ).run(to, offset, now, prefix);
    const here = db
      .prepare('UPDATE documents SET path = ?, updated_at = ? WHERE removed = 0 AND path = ?')
      .run(to, now, from);
    const below = db
      .prepare(
        `UPDATE documents SET path = ? || substr(path, ?), updated_at = ?
         WHERE removed = 0 AND path LIKE ? ESCAPE '\\'`,
      )
      .run(to, offset, now, prefix);
    moved = Number(here.changes) + Number(below.changes);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return moved;
}

/**
 * Moving a file changes what it IS, because "is this the app's own output" and "is this a
 * template" are decided by where it lives. Reset its pipeline state to match, and say what
 * changed so the caller can tell the user.
 */
function reclassify(documentId: string, from: string, to: string): string {
  const wasManaged = isTemplateFolder(from) || isGeneratedOutput(from);
  const nowManaged = isTemplateFolder(to) || isGeneratedOutput(to);
  if (wasManaged === nowManaged) return '';

  const db = getDb();
  if (nowManaged) {
    // Pages and segments are deliberately KEPT. An analysis that already cited this document
    // resolves its citations through them, and deleting would be irreversible.
    db.prepare(
      `UPDATE documents SET state = 'listed', stage = 'recebido', state_detail = 'Ficheiro da aplicação (template ou documento gerado) — não é indexado.'
       WHERE document_id = ?`,
    ).run(documentId);
    return 'Deixa de ser material de origem para análises. As citações já feitas mantêm-se.';
  }
  db.prepare(
    `UPDATE documents SET state = 'listed', stage = 'recebido', state_detail = 'Movido para a pasta do cliente — a aguardar processamento.'
     WHERE document_id = ?`,
  ).run(documentId);
  return 'Passa a ser tratado como documento de origem e pode ser citado por outras análises.';
}

