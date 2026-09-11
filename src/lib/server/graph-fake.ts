import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getSetting, setSetting } from '@/lib/server/db';
import { LEGAL_DATA_DIR } from '@/lib/server/paths';

// A crude but honest stand-in for the client's OneDrive, used by the test suite.
//
// The old fake swapped only upload and conversion, which left the riskiest code in the app
// — the delta sync, folder resolution, moves and deletes — with no coverage at all, because
// `isLibraryConfigured()` was false in every test and `syncLibrary()` returned immediately.
// This makes `<dataDir>/fake-onedrive` a real drive: a directory tree with stable item ids,
// a synthesised delta feed, and rename/move/delete that behave the way Graph's do.
//
// The three behaviours it asserts by fiat — and which therefore still need one smoke test
// against a real tenant — are: a move PRESERVES the item id, a folder delete is recursive,
// and a duplicate name conflicts.

export function fakeMode(): boolean {
  return process.env.LEGAL_FAKE_GRAPH === '1';
}

/**
 * Which Microsoft account the fake is signed in to. The app is meant to survive somebody
 * connecting a DIFFERENT account, so the fake has to be able to be a different account:
 * each one is its own directory, with its own ids, and nothing crosses between them.
 */
export function fakeAccount(): string {
  return String(getSetting('graph.fake_account') || '') || 'a';
}

export function setFakeAccount(account: string): void {
  setSetting('graph.fake_account', account);
}

export function fakeAccountEmail(account = fakeAccount()): string {
  return `conta-${account}@exemplo.pt`;
}

export function fakeDriveId(account = fakeAccount()): string {
  return `fake-drive-${account}`;
}

export function fakeRoot(): string {
  const account = fakeAccount();
  // Account 'a' keeps the original directory name: it is the drive every other test means.
  const dir = path.join(LEGAL_DATA_DIR, account === 'a' ? 'fake-onedrive' : `fake-onedrive-${account}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The synthetic id of the drive root — what `graph.library_folder_id` holds. */
export function fakeRootId(account = fakeAccount()): string {
  return account === 'a' ? 'fake-root' : `fake-root-${account}`;
}

/** The absolute "Graph path" of the drive root, for parentReference.path. */
export function fakeRootPath(account = fakeAccount()): string {
  return account === 'a' ? '/drive/root:/fake-onedrive' : `/drive/root:/fake-onedrive-${account}`;
}

const IDS_FILE = '.ids.json';

type IdMap = { byId: Record<string, string>; byPath: Record<string, string>; nextSeq: number };

function idsPath(): string {
  return path.join(fakeRoot(), IDS_FILE);
}

function readIds(): IdMap {
  try {
    const raw = JSON.parse(readFileSync(idsPath(), 'utf8')) as IdMap;
    return { byId: raw.byId || {}, byPath: raw.byPath || {}, nextSeq: raw.nextSeq || 1 };
  } catch {
    return { byId: {}, byPath: {}, nextSeq: 1 };
  }
}

function writeIds(map: IdMap): void {
  writeFileSync(idsPath(), JSON.stringify(map, null, 2));
}

/**
 * The id of an item at `relativePath`, minted on first sight and stable thereafter.
 *
 * Ids deliberately do NOT derive from the path. If they did, a move would change the id and
 * the one property the legacy migration has to prove — that moving a file preserves its
 * identity, so nothing re-ingests and no citation breaks — could not be tested at all.
 */
export function fakeIdFor(relativePath: string): string {
  if (!relativePath) return fakeRootId();
  const map = readIds();
  const existing = map.byPath[relativePath];
  if (existing) return existing;
  // Account-prefixed: two drives must not mint the same id, or a stale id left over from a
  // previous account would resolve on the new one and hide the very bug this models.
  const id = `fake-${fakeAccount()}-${map.nextSeq}`;
  map.nextSeq += 1;
  map.byId[id] = relativePath;
  map.byPath[relativePath] = id;
  writeIds(map);
  return id;
}

/** Where the item with this id currently lives, or '' if it is unknown or deleted. */
export function fakePathOf(itemId: string): string {
  if (itemId === fakeRootId()) return '';
  return readIds().byId[itemId] || '';
}

export function fakeAbsolute(relativePath: string): string {
  return relativePath ? path.join(fakeRoot(), relativePath) : fakeRoot();
}

/** Re-point an id (and every descendant id) after a rename or a move. */
function remapPrefix(from: string, to: string): void {
  const map = readIds();
  for (const [id, current] of Object.entries(map.byId)) {
    if (current !== from && !current.startsWith(`${from}/`)) continue;
    const next = current === from ? to : `${to}${current.slice(from.length)}`;
    delete map.byPath[current];
    map.byId[id] = next;
    map.byPath[next] = id;
  }
  writeIds(map);
}

function forgetPrefix(prefix: string): void {
  const map = readIds();
  for (const [id, current] of Object.entries(map.byId)) {
    if (current !== prefix && !current.startsWith(`${prefix}/`)) continue;
    delete map.byId[id];
    delete map.byPath[current];
  }
  writeIds(map);
}

// --- the drive, as items ---------------------------------------------------

export type FakeItem = {
  id: string;
  name: string;
  relativePath: string;
  isFolder: boolean;
  size: number;
  modifiedAt: number;
  /** Content hash for files — the fake's cTag, so a content change is detectable. */
  cTag: string;
  parentId: string;
  parentPath: string;
};

/**
 * Re-point ids whose file moved without going through `fakePatchItem`.
 *
 * On a real drive an item keeps its id however it was moved — dragged in the OneDrive web
 * UI, moved by a sync client, or PATCHed by us. A test that moves a file with `renameSync`
 * is doing the same thing, and the fake has to agree, or it would report the move as a
 * delete plus a create and no test could tell a genuine re-file bug from the fake's own
 * bookkeeping. Matched on content hash; identical files are ambiguous and take the first.
 */
function reconcileMovedFiles(onDisk: Array<{ relativePath: string; sha: string }>): void {
  const map = readIds();
  const missing = Object.entries(map.byId).filter(([, p]) => !existsSync(fakeAbsolute(p)));
  if (missing.length === 0) return;

  const unassigned = onDisk.filter((entry) => !map.byPath[entry.relativePath]);
  if (unassigned.length === 0) return;

  const shaOf = new Map<string, string>();
  for (const [, p] of missing) {
    // The vanished path's content is gone; match on what the id last saw at that name.
    shaOf.set(p, p);
  }
  const takenBy = new Set<string>();
  for (const [id, oldPath] of missing) {
    const oldName = oldPath.slice(oldPath.lastIndexOf('/') + 1);
    const candidate = unassigned.find(
      (entry) => !takenBy.has(entry.relativePath) && entry.relativePath.endsWith(`/${oldName}`),
    );
    if (!candidate) continue;
    takenBy.add(candidate.relativePath);
    delete map.byPath[oldPath];
    map.byId[id] = candidate.relativePath;
    map.byPath[candidate.relativePath] = id;
  }
  writeIds(map);
}

/** Everything on the drive, parents before children — the order a delta feed guarantees. */
export function fakeWalk(): FakeItem[] {
  reconcileMovedFiles(collectPaths());
  const out: FakeItem[] = [];
  const visit = (relative: string) => {
    const absolute = fakeAbsolute(relative);
    if (!existsSync(absolute)) return;
    const entries = readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    // Folders first, so a child never appears before the folder that explains where it is.
    for (const dirent of [...entries].sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()))) {
      if (dirent.name === IDS_FILE) continue;
      const childRelative = relative ? `${relative}/${dirent.name}` : dirent.name;
      const childAbsolute = fakeAbsolute(childRelative);
      const stat = statSync(childAbsolute);
      const parentRelative = relative;
      out.push({
        id: fakeIdFor(childRelative),
        name: dirent.name,
        relativePath: childRelative,
        isFolder: dirent.isDirectory(),
        size: dirent.isDirectory() ? 0 : stat.size,
        modifiedAt: Math.floor(stat.mtimeMs),
        cTag: dirent.isDirectory() ? '' : createHash('sha256').update(readFileSync(childAbsolute)).digest('hex'),
        parentId: parentRelative ? fakeIdFor(parentRelative) : fakeRootId(),
        parentPath: parentRelative ? `${fakeRootPath()}/${parentRelative}` : fakeRootPath(),
      });
      if (dirent.isDirectory()) visit(childRelative);
    }
  };
  visit('');
  return out;
}

/** Every path currently on the drive, with its content hash for files. */
function collectPaths(): Array<{ relativePath: string; sha: string }> {
  const out: Array<{ relativePath: string; sha: string }> = [];
  const visit = (relative: string) => {
    const absolute = fakeAbsolute(relative);
    if (!existsSync(absolute)) return;
    for (const dirent of readdirSync(absolute, { withFileTypes: true })) {
      if (dirent.name === IDS_FILE) continue;
      const childRelative = relative ? `${relative}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        out.push({ relativePath: childRelative, sha: '' });
        visit(childRelative);
      } else {
        out.push({
          relativePath: childRelative,
          sha: createHash('sha256').update(readFileSync(fakeAbsolute(childRelative))).digest('hex'),
        });
      }
    }
  };
  visit('');
  return out;
}

export function fakeItemById(itemId: string): FakeItem | null {
  const relative = fakePathOf(itemId);
  if (itemId !== fakeRootId() && !relative) return null;
  return fakeWalk().find((item) => item.id === itemId) || null;
}

// --- operations ------------------------------------------------------------

export function fakeCreateFolder(parentId: string, name: string): { id: string; name: string } {
  const parent = parentId === fakeRootId() ? '' : fakePathOf(parentId);
  if (parentId !== fakeRootId() && !parent) throw new Error('fake: parent folder not found');
  const relative = parent ? `${parent}/${name}` : name;
  if (existsSync(fakeAbsolute(relative))) {
    const error = new Error('nameAlreadyExists') as Error & { status?: number };
    error.status = 409;
    throw error;
  }
  mkdirSync(fakeAbsolute(relative), { recursive: true });
  return { id: fakeIdFor(relative), name };
}

/** Rename and/or move, preserving the item id — the property the migration depends on. */
export function fakePatchItem(itemId: string, body: { name?: string; parentId?: string }): FakeItem {
  const from = fakePathOf(itemId);
  if (!from) throw new Error('fake: item not found');
  const currentParent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const currentName = from.slice(from.lastIndexOf('/') + 1);

  const name = body.name ?? currentName;
  const parent =
    body.parentId === undefined
      ? currentParent
      : body.parentId === fakeRootId()
        ? ''
        : fakePathOf(body.parentId);
  if (body.parentId !== undefined && body.parentId !== fakeRootId() && !parent) {
    throw new Error('fake: destination folder not found');
  }

  const to = parent ? `${parent}/${name}` : name;
  if (to === from) return fakeItemById(itemId)!;
  if (existsSync(fakeAbsolute(to))) {
    const error = new Error('nameAlreadyExists') as Error & { status?: number };
    error.status = 409;
    throw error;
  }
  mkdirSync(path.dirname(fakeAbsolute(to)), { recursive: true });
  renameSync(fakeAbsolute(from), fakeAbsolute(to));
  remapPrefix(from, to);
  return fakeItemById(itemId)!;
}

/** Graph's folder delete is ALWAYS recursive; so is this one. */
export function fakeDeleteItem(itemId: string): void {
  const relative = fakePathOf(itemId);
  if (!relative) return; // already gone — the end state the caller wanted
  rmSync(fakeAbsolute(relative), { recursive: true, force: true });
  forgetPrefix(relative);
}

export function fakeReadFile(itemId: string): Buffer {
  const relative = fakePathOf(itemId);
  const absolute = fakeAbsolute(relative);
  if (!relative || !existsSync(absolute)) throw new Error('fake: file not found');
  return readFileSync(absolute);
}

export function fakeWriteFile(relativePath: string, bytes: Buffer): { id: string } {
  const absolute = fakeAbsolute(relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, bytes);
  return { id: fakeIdFor(relativePath) };
}

// --- the delta feed --------------------------------------------------------

/**
 * A synthesised delta page.
 *
 * The first call (given the folder id) returns the whole tree and a deltaLink. A later call
 * with that link returns only what changed since — items whose mtime moved, and a `deleted`
 * entry for every id the previous pass knew about that is no longer on disk. That is enough
 * to exercise the three cases the real sync gets wrong: an incremental page that does not
 * re-list a file's parents, a move, and a delete.
 *
 * The cursor is a timestamp plus the set of ids seen, encoded in the link itself, so nothing
 * has to be stored on the app's side.
 */
export type FakeDeltaCursor = { at: number; items: Record<string, string> };

const DELTA_PREFIX = 'https://fake-onedrive/delta?cursor=';

export function fakeDeltaPage(folderIdOrLink: string): {
  value: Array<Record<string, unknown>>;
  '@odata.deltaLink': string;
} {
  const items = fakeWalk();
  const previous: FakeDeltaCursor | null = folderIdOrLink.startsWith(DELTA_PREFIX)
    ? (JSON.parse(Buffer.from(folderIdOrLink.slice(DELTA_PREFIX.length), 'base64url').toString('utf8')) as FakeDeltaCursor)
    : null;

  const value: Array<Record<string, unknown>> = [];
  for (const item of items) {
    // An incremental pass reports only what actually changed — a folder whose contents did
    // not move is NOT re-listed, which is precisely the situation that used to make the sync
    // re-file a moved document at the library root.
    //
    // "Changed" is mtime OR path: moving a file does not touch its mtime, so an mtime-only
    // check would make a move invisible and the fake would silently disagree with Graph
    // about the one operation the migration depends on.
    if (previous) {
      const knownPath = previous.items[item.id];
      const unchanged = knownPath !== undefined && knownPath === item.relativePath && item.modifiedAt <= previous.at;
      if (unchanged) continue;
    }
    value.push({
      id: item.id,
      name: item.name,
      cTag: item.cTag,
      eTag: item.cTag,
      size: item.size,
      lastModifiedDateTime: new Date(item.modifiedAt).toISOString(),
      webUrl: `fake://onedrive/${item.relativePath}`,
      ...(item.isFolder ? { folder: {} } : { file: { mimeType: mimeForName(item.name) } }),
      parentReference: { id: item.parentId, path: item.parentPath },
    });
  }

  if (previous) {
    const alive = new Set(items.map((item) => item.id));
    for (const id of Object.keys(previous.items)) {
      if (!alive.has(id)) value.push({ id, deleted: { state: 'deleted' } });
    }
  }

  const cursor: FakeDeltaCursor = {
    at: Date.now(),
    items: Object.fromEntries(items.map((item) => [item.id, item.relativePath])),
  };
  const link = `${DELTA_PREFIX}${Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')}`;
  return { value, '@odata.deltaLink': link };
}

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  eml: 'message/rfc822',
  msg: 'application/vnd.ms-outlook',
  txt: 'text/plain',
  json: 'application/json',
};

/** What a real delta reports for a file — not `application/octet-stream` for everything. */
function mimeForName(name: string): string {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return MIME_BY_EXTENSION[extension] || 'application/octet-stream';
}

export function isFakeDeltaLink(value: string): boolean {
  return value.startsWith(DELTA_PREFIX);
}
