import {
  isGeneratedOutput,
  isStructuralFolder,
  isTemplateFolder,
  LIBRARY_FOLDERS,
} from '@/lib/library-layout';
import { genId } from '@/lib/server/crypto';
import { getDb } from '@/lib/server/db';
import { isLibraryConfigured } from '@/lib/server/msgraph';
import { folderImpact, moveItem, type ItemRef } from '@/lib/server/repo/library-items';

// The one-time move of everything the client already had into "1. Documentos oficiais".
//
// The three folders were introduced over a library the client had already filled, and
// nothing of theirs was moved — so until now the app carried a fiction (`displayPath`) that
// LISTED those files under the official folder without them being there. This ends that:
// the files actually move, once, and the fiction is deleted with phase 5.
//
// Two properties make it safe to run against a live drive:
//
// 1. **Only top-level items move.** A OneDrive folder move is a single PATCH that carries
//    the whole subtree with it, every descendant keeping its id. Enumerating the subtree
//    would be hundreds of calls to achieve exactly the same end state, with hundreds more
//    chances to half-fail.
// 2. **Ids are preserved.** `PATCH {parentReference:{id}}` keeps the item id, its cTag and
//    its content, so `documents.drive_item_id` still matches, nothing re-ingests, and every
//    citation already resolved through a page of that document still resolves.
//
// The plan is never stored. It is recomputed from current state every time it is asked for,
// which is what makes a re-run after a partial failure pick up precisely the remainder
// rather than needing a resume token.

export type MigrationItemKind = 'folder' | 'file';

export type MigrationItem = {
  kind: MigrationItemKind;
  /** `folder_id` for a folder, `document_id` for a file — what a run selects by. */
  id: string;
  name: string;
  from: string;
  to: string;
  /** How many document rows travel with this item. A folder carries its whole subtree. */
  documents: number;
  /** Something already sits at `to`. The item is listed but never moved automatically. */
  conflict: boolean;
};

/** `pending` — nothing tried yet; `partial` — some moved, some left; `done` — nothing left. */
export type MigrationState = 'pending' | 'partial' | 'done';

export type MigrationPlan = {
  state: MigrationState;
  /** False on a local-only install: the move still happens, just only in the mirror. */
  configured: boolean;
  items: MigrationItem[];
  moved: number;
  failed: number;
  skipped: number;
};

export type MigrationOutcome = {
  id: string;
  name: string;
  status: 'moved' | 'failed' | 'skipped';
  detail: string;
  documents: number;
};

export type MigrationRun = MigrationPlan & { results: MigrationOutcome[] };

type FolderRow = { folder_id: string; name: string; path: string };
type FileRow = { document_id: string; name: string };

const OFFICIAL = LIBRARY_FOLDERS.official;

/**
 * Top-level items that are the client's own material.
 *
 * "Top-level" is `path` with no separator in it for a folder, and the empty path for a file
 * — a file's `path` is the folder that holds it, so a file at the library root has none.
 */
function pendingItems(): MigrationItem[] {
  const db = getDb();
  const items: MigrationItem[] = [];

  const folders = db
    .prepare(
      `SELECT folder_id, name, path FROM drive_folders
        WHERE removed = 0 AND path <> '' AND path NOT LIKE '%/%'
        ORDER BY name COLLATE NOCASE`,
    )
    .all() as FolderRow[];

  for (const folder of folders) {
    // The app's own three folders, and the pre-reorganisation output folder, are not the
    // client's material and must never be moved inside one another.
    if (isStructuralFolder(folder.path) || isGeneratedOutput(folder.path) || isTemplateFolder(folder.path)) {
      continue;
    }
    const to = `${OFFICIAL}/${folder.name}`;
    items.push({
      kind: 'folder',
      id: folder.folder_id,
      name: folder.name,
      from: folder.path,
      to,
      documents: folderImpact(folder.path).documents,
      conflict: Boolean(
        db.prepare('SELECT 1 FROM drive_folders WHERE path = ? AND removed = 0').get(to),
      ),
    });
  }

  const files = db
    .prepare(
      `SELECT document_id, name FROM documents
        WHERE removed = 0 AND path = ''
        ORDER BY name COLLATE NOCASE`,
    )
    .all() as FileRow[];

  for (const file of files) {
    items.push({
      kind: 'file',
      id: file.document_id,
      name: file.name,
      from: '',
      to: OFFICIAL,
      documents: 1,
      conflict: Boolean(
        db
          .prepare('SELECT 1 FROM documents WHERE path = ? AND name = ? AND removed = 0')
          .get(OFFICIAL, file.name),
      ),
    });
  }

  return items;
}

/**
 * Is there anything left to arrange? The Library asks this on every listing to decide
 * whether to point at the migration screen, so it deliberately avoids `pendingItems()` —
 * that one counts the documents under every candidate folder, which is a query per folder
 * for an answer this only needs as a yes or no.
 */
export function hasPendingMigration(): boolean {
  const db = getDb();
  if (db.prepare("SELECT 1 FROM documents WHERE removed = 0 AND path = '' LIMIT 1").get()) return true;
  const folders = db
    .prepare("SELECT path FROM drive_folders WHERE removed = 0 AND path <> '' AND path NOT LIKE '%/%'")
    .all() as { path: string }[];
  return folders.some(
    (folder) =>
      !isStructuralFolder(folder.path) && !isGeneratedOutput(folder.path) && !isTemplateFolder(folder.path),
  );
}

function logCounts(): { moved: number; failed: number; skipped: number } {
  const rows = getDb()
    .prepare('SELECT status, COUNT(*) AS n FROM migration_log GROUP BY status')
    .all() as { status: string; n: number }[];
  const of = (status: string) => Number(rows.find((r) => r.status === status)?.n || 0);
  return { moved: of('moved'), failed: of('failed'), skipped: of('skipped') };
}

export function planMigration(): MigrationPlan {
  const items = pendingItems();
  const counts = logCounts();
  const attempted = counts.moved + counts.failed + counts.skipped;
  // Derived, never stored: "nothing left to move" IS the definition of done, so a client who
  // tidied their own drive by hand is finished without having run anything here.
  const state: MigrationState = items.length === 0 ? 'done' : attempted > 0 ? 'partial' : 'pending';
  return { state, configured: isLibraryConfigured(), items, ...counts };
}

function record(item: MigrationItem, status: MigrationOutcome['status'], detail: string, documents: number): void {
  getDb()
    .prepare(
      `INSERT INTO migration_log (entry_id, kind, item_id, name, from_path, to_path, status, detail, documents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(genId('mig'), item.kind, item.id, item.name, item.from, item.to, status, detail, documents, Date.now());
}

/**
 * Move the selected items, one at a time.
 *
 * Sequential on purpose. Each `moveItem` is a drive call followed by its own local
 * transaction, so stopping after any one of them leaves a mirror that still tells the truth
 * — which is the whole reason this is resumable. Firing them in parallel would buy seconds
 * on a handful of items and cost that guarantee.
 */
export async function runMigration(ids: string[]): Promise<MigrationRun> {
  const wanted = new Set(ids.filter(Boolean));
  const selected = planMigration().items.filter((item) => wanted.has(item.id));
  const results: MigrationOutcome[] = [];

  for (const item of selected) {
    if (item.conflict) {
      const detail = `Já existe “${item.name}” em ${OFFICIAL}.`;
      record(item, 'skipped', detail, 0);
      results.push({ id: item.id, name: item.name, status: 'skipped', detail, documents: 0 });
      continue;
    }
    try {
      const ref: ItemRef =
        item.kind === 'folder'
          ? { kind: 'folder', folderId: item.id }
          : { kind: 'file', documentId: item.id };
      const outcome = await moveItem(ref, OFFICIAL);
      record(item, 'moved', '', outcome.movedDocuments);
      results.push({
        id: item.id,
        name: item.name,
        status: 'moved',
        detail: '',
        documents: outcome.movedDocuments,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      record(item, 'failed', detail, 0);
      results.push({ id: item.id, name: item.name, status: 'failed', detail, documents: 0 });
    }
  }

  // Recomputed after the run, so the caller sees the state the next visitor would see.
  return { ...planMigration(), results };
}
