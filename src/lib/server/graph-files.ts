import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ApiError } from '@/app/api/_helpers';
import { ANALYSIS_FOLDER_NAMES, LIBRARY_FOLDERS, PREVIOUS_GENERATED_FOLDER, STRUCTURAL_FOLDERS } from '@/lib/library-layout';
import { fakeAbsolute, fakeIdFor, fakeMode, fakePathOf, fakeRoot } from '@/lib/server/graph-fake';
import { deleteSetting, getSetting, setSetting } from '@/lib/server/db';
import { graphFetch, libraryFolderId as graphLibraryFolderId } from '@/lib/server/msgraph';
import { LEGAL_DATA_DIR } from '@/lib/server/paths';

// OneDrive file operations for the final-document chain (briefing §12 "Conversão para
// PDF"): upload the final DOCX, convert it via Graph, upload the PDF next to it. All
// generated artefacts live in one app-managed subfolder of the library folder.
//
// LEGAL_FAKE_GRAPH=1 (test harness only) swaps in a deterministic local fake: "OneDrive"
// is a directory under the data dir, and "conversion" produces a small valid PDF whose
// content embeds the DOCX hash — enough for the §17 suite to prove storage, hash binding
// and failure handling without a tenant. Bytes containing the ASCII marker FAILCONV make
// the fake conversion fail, exercising the §16 failure path.

/** A minimal one-page PDF with the given text — valid enough for pdfjs to count pages. */
export function minimalPdf(text: string): Buffer {
  const safe = text.replace(/[()\\]/g, '');
  const content = `BT /F1 12 Tf 50 750 Td (${safe}) Tj ET`;
  const objects = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n',
    `4 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj\n`,
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(body.length);
    body += object;
  }
  const xrefAt = body.length;
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer<</Size 6/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

async function ensureChildFolder(parentId: string, name: string): Promise<string> {
  const res = await graphFetch(`/me/drive/items/${encodeURIComponent(parentId)}/children`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      folder: {},
      // "fail" then reuse: never clobber a folder that already holds documents.
      '@microsoft.graph.conflictBehavior': 'fail',
    }),
  });
  if (res.ok) return ((await res.json()) as { id: string }).id;
  if (res.status === 404) {
    // The PARENT is gone, not this folder. Signalled as 404 so `ensureFolderPath` can tell
    // "my cached id is stale" apart from "OneDrive refused" — the first is recoverable by
    // walking again from the library root, the second is not.
    throw new ApiError(`Parent folder for "${name}" no longer exists.`, 404);
  }
  if (res.status === 409) {
    const existing = await graphFetch(
      `/me/drive/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(name)}?$select=id`,
    );
    if (existing.ok) return ((await existing.json()) as { id: string }).id;
  }
  throw new ApiError(`Could not create the folder "${name}" (HTTP ${res.status}).`, 502);
}

/**
 * Resolve a folder path relative to the library root, creating each missing level. Every
 * level is cached under `graph.folder.<path>`; that cache is cleared when the library
 * folder changes, because the ids belong to the old location.
 */
async function walkFolderPath(relativePath: string, useCache: boolean): Promise<string> {
  const libraryFolderId = graphLibraryFolderId();
  if (!libraryFolderId) throw new ApiError('Library folder is not configured.', 400);
  let parentId = libraryFolderId;
  let accumulated = '';
  for (const segment of relativePath.split('/').filter(Boolean)) {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment;
    const key = `graph.folder.${accumulated}`;
    if (useCache) {
      const cached = String(getSetting(key) || '');
      if (cached) {
        parentId = cached;
        continue;
      }
    }
    parentId = await ensureChildFolder(parentId, segment);
    setSetting(key, parentId);
  }
  return parentId;
}

function clearFolderPathCache(relativePath: string): void {
  let accumulated = '';
  for (const segment of relativePath.split('/').filter(Boolean)) {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment;
    deleteSetting(`graph.folder.${accumulated}`);
  }
}

/** Is the chosen library folder still reachable on the account that is connected now? */
async function libraryRootReachable(): Promise<boolean> {
  const id = graphLibraryFolderId();
  if (!id) return false;
  const res = await graphFetch(`/me/drive/items/${encodeURIComponent(id)}?$select=id`);
  return res.ok;
}

export async function ensureFolderPath(relativePath: string): Promise<string> {
  try {
    return await walkFolderPath(relativePath, true);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    // A cached id names a folder somebody deleted — or one on the drive of a PREVIOUS
    // account. The cache is what failed, not the request, so drop it and walk again. This
    // is the whole reason a switched account used to surface as "Could not create the
    // folder (HTTP 404)" from inside PDF conversion.
    if (!(await libraryRootReachable())) {
      throw new ApiError(
        'A pasta da biblioteca já não existe nesta conta do OneDrive. Escolha-a novamente em Definições.',
        409,
      );
    }
    clearFolderPathCache(relativePath);
    return walkFolderPath(relativePath, false);
  }
}

/**
 * The bytes of a library item at this path, or null when there is nothing there. Publishing
 * a built-in template compares against these bytes to tell an untouched copy of a previous
 * version from a file the client has since edited.
 */
export async function readLibraryItem(relativePath: string): Promise<Buffer | null> {
  if (fakeMode()) {
    const local = path.join(fakeRoot(), relativePath);
    return existsSync(local) ? readFileSync(local) : null;
  }
  const libraryFolderId = graphLibraryFolderId();
  if (!libraryFolderId) return null;
  const encoded = relativePath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  const res = await graphFetch(`/me/drive/items/${encodeURIComponent(libraryFolderId)}:/${encoded}:/content`);
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

/** Does an item exist at this path under the library root? Used before publishing a file. */
export async function libraryItemExists(relativePath: string): Promise<boolean> {
  if (fakeMode()) return existsSync(path.join(fakeRoot(), relativePath));
  const libraryFolderId = graphLibraryFolderId();
  if (!libraryFolderId) return false;
  const encoded = relativePath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  const res = await graphFetch(`/me/drive/items/${encodeURIComponent(libraryFolderId)}:/${encoded}?$select=id`);
  return res.ok;
}

/** True when a local tree contains any file; empty structural subfolders do not count. */
function localTreeHasFiles(directory: string): boolean {
  return readdirSync(directory, { withFileTypes: true }).some((entry) =>
    entry.isDirectory() ? localTreeHasFiles(path.join(directory, entry.name)) : true,
  );
}

/** Graph equivalent of localTreeHasFiles. Pagination is treated as non-empty for safety. */
async function graphTreeHasFiles(itemId: string): Promise<boolean> {
  const response = await graphFetch(`/me/drive/items/${encodeURIComponent(itemId)}/children?$select=id,folder&$top=200`);
  if (!response.ok) throw new ApiError(`Não foi possível verificar a pasta de resultados (HTTP ${response.status}).`, 502);
  const data = await response.json() as { value?: Array<{ id: string; folder?: unknown }>; '@odata.nextLink'?: string };
  if (data['@odata.nextLink']) return true;
  for (const child of data.value || []) {
    if (!child.folder || await graphTreeHasFiles(child.id)) return true;
  }
  return false;
}

/** Rename the former generated-output root in place, preserving its OneDrive item id. */
async function migrateResultsFolder(): Promise<boolean> {
  if (fakeMode()) {
    const previous = path.join(fakeRoot(), PREVIOUS_GENERATED_FOLDER);
    const current = path.join(fakeRoot(), LIBRARY_FOLDERS.generated);
    if (!existsSync(previous)) return false;
    if (existsSync(current)) {
      if (localTreeHasFiles(current)) return false;
      rmSync(current, { recursive: true, force: true });
    }
    renameSync(previous, current);
    return true;
  }
  const libraryFolderId = graphLibraryFolderId();
  if (!libraryFolderId) return false;
  const itemAt = async (relativePath: string): Promise<{ id: string } | null> => {
    const encoded = relativePath.split('/').map((part) => encodeURIComponent(part)).join('/');
    const response = await graphFetch(`/me/drive/items/${encodeURIComponent(libraryFolderId)}:/${encoded}?$select=id`);
    return response.ok ? await response.json() as { id: string } : null;
  };
  const [previous, current] = await Promise.all([itemAt(PREVIOUS_GENERATED_FOLDER), itemAt(LIBRARY_FOLDERS.generated)]);
  if (!previous) return false;
  if (current) {
    if (await graphTreeHasFiles(current.id)) return false;
    const removed = await graphFetch(`/me/drive/items/${encodeURIComponent(current.id)}`, { method: 'DELETE' });
    if (!removed.ok && removed.status !== 404) {
      throw new ApiError(`Não foi possível remover a pasta de resultados vazia (HTTP ${removed.status}).`, 502);
    }
  }
  const renamed = await graphFetch(`/me/drive/items/${encodeURIComponent(previous.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: LIBRARY_FOLDERS.generated }),
  });
  if (!renamed.ok) throw new ApiError(`Não foi possível mudar o nome da pasta de resultados (HTTP ${renamed.status}).`, 502);

  setSetting(`graph.folder.${LIBRARY_FOLDERS.generated}`, previous.id);
  deleteSetting(`graph.folder.${PREVIOUS_GENERATED_FOLDER}`);
  for (const workflowName of Object.values(ANALYSIS_FOLDER_NAMES)) {
    const oldKey = `graph.folder.${PREVIOUS_GENERATED_FOLDER}/${workflowName}`;
    const childId = String(getSetting(oldKey) || '');
    if (childId) setSetting(`graph.folder.${LIBRARY_FOLDERS.generated}/${workflowName}`, childId);
    deleteSetting(oldKey);
  }
  return true;
}

/**
 * Create the folders the app expects the library to have. Idempotent, and a no-op once it
 * has succeeded for this library folder — the guard is keyed on the folder id, so pointing
 * the app at a different OneDrive folder runs it again there.
 */
export async function ensureLibraryStructure(): Promise<{ created: string[]; skipped: boolean }> {
  const libraryFolderId = graphLibraryFolderId();
  if (!fakeMode() && !libraryFolderId) return { created: [], skipped: true };
  await migrateResultsFolder();
  if (String(getSetting('graph.structure_ready') || '') === structureScope()) {
    return { created: [], skipped: false };
  }
  const created: string[] = [];
  for (const folder of STRUCTURAL_FOLDERS) {
    if (fakeMode()) {
      const dir = path.join(fakeRoot(), folder);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        created.push(folder);
      }
      continue;
    }
    if (await libraryItemExists(folder)) {
      // Still walk it, so the id cache is warm for the uploads that follow.
      await ensureFolderPath(folder);
      continue;
    }
    await ensureFolderPath(folder);
    created.push(folder);
  }
  setSetting('graph.structure_ready', structureScope());
  return { created, skipped: false };
}

/**
 * What "the structure is ready" is true OF. The drive belongs in the key: keyed on the
 * folder id alone, connecting a different Microsoft account left the guard satisfied while
 * every id behind it pointed at a drive the new account cannot open.
 */
function structureScope(): string {
  if (fakeMode()) return 'fake:results-v1';
  return `${String(getSetting('graph.drive_id') || '')}:${graphLibraryFolderId()}:results-v1`;
}

export type UploadedFile = { itemId: string; webUrl: string };

/**
 * Upload bytes into a folder under the library root — the door for the app's own outputs.
 * `relativeFolder` is a full path, not a single folder name: outputs live two levels deep
 * (workflow, then analysis) and templates one.
 */
export async function uploadGeneratedFile(
  name: string,
  bytes: Buffer,
  mime: string,
  relativeFolder: string,
): Promise<UploadedFile> {
  if (fakeMode()) {
    const dir = path.join(fakeRoot(), relativeFolder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), bytes);
    // The SAME id the delta walk will report for this path. A different one here would
    // make the next sync insert a second row for a file the app just uploaded.
    const relative = [relativeFolder, name].filter(Boolean).join('/');
    return { itemId: fakeIdFor(relative), webUrl: `fake://onedrive/${relative}` };
  }
  const folderId = await ensureFolderPath(relativeFolder);
  const res = await graphFetch(
    `/me/drive/items/${encodeURIComponent(folderId)}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=replace`,
    { method: 'PUT', headers: { 'Content-Type': mime }, body: new Uint8Array(bytes) },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(`OneDrive upload failed (HTTP ${res.status}): ${text.slice(0, 200)}`, 502);
  }
  const data = (await res.json()) as { id: string; webUrl?: string };
  return { itemId: data.id, webUrl: String(data.webUrl || '') };
}

/**
 * Upload a file into the LIBRARY folder itself (optionally under a subfolder path) — the
 * door for documents the user brings through the app: they land in the client's OneDrive
 * exactly like anything else, and the next delta sync sees them as normal library items.
 */
export async function uploadToLibrary(
  name: string,
  bytes: Buffer,
  folderPath = '',
  mime = 'application/octet-stream',
  // 'rename' by default so a user upload never destroys a file already at that name.
  // 'replace' is for the one caller that has established the target is ours to overwrite.
  conflictBehavior: 'rename' | 'replace' = 'rename',
): Promise<UploadedFile> {
  if (fakeMode()) {
    // Honour folderPath, as uploadGeneratedFile's fake already does. Writing flat here made
    // the fake disagree with Graph about the one thing the caller asked for, so no test
    // could observe where a file actually lands.
    const dir = path.join(fakeRoot(), folderPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), bytes);
    const relative = [folderPath, name].filter(Boolean).join('/');
    return { itemId: fakeIdFor(relative), webUrl: `fake://onedrive/${relative}` };
  }
  const libraryFolderId = graphLibraryFolderId();
  if (!libraryFolderId) throw new ApiError('Library folder is not configured.', 400);
  const relative = [folderPath, name]
    .filter(Boolean)
    .join('/')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  const res = await graphFetch(
    `/me/drive/items/${encodeURIComponent(libraryFolderId)}:/${relative}:/content?@microsoft.graph.conflictBehavior=${conflictBehavior}`,
    { method: 'PUT', headers: { 'Content-Type': mime }, body: new Uint8Array(bytes) },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(`OneDrive upload failed (HTTP ${res.status}): ${text.slice(0, 200)}`, 502);
  }
  const data = (await res.json()) as { id: string; webUrl?: string; name?: string };
  return { itemId: data.id, webUrl: String(data.webUrl || '') };
}

/**
 * Overwrite the contents of an item that already exists, keeping its id. Used by the
 * letterhead backfill: the documents it rewrites are already linked from `conversions` and
 * already shared with the client, so a new item would orphan both.
 */
export async function replaceItemContent(itemId: string, bytes: Buffer, mime: string): Promise<void> {
  if (fakeMode()) {
    const relative = fakePathOf(itemId);
    if (!relative) throw new ApiError(`Unknown fake item ${itemId}.`, 404);
    const target = fakeAbsolute(relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    return;
  }
  const res = await graphFetch(`/me/drive/items/${encodeURIComponent(itemId)}/content`, {
    method: 'PUT',
    headers: { 'Content-Type': mime },
    body: new Uint8Array(bytes),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(`OneDrive replace failed (HTTP ${res.status}): ${text.slice(0, 200)}`, 502);
  }
}

/** Convert an uploaded DOCX to PDF via Graph (§12: format=pdf). Returns the PDF bytes. */
export async function convertItemToPdf(itemId: string, docxBytes: Buffer): Promise<Buffer> {
  if (fakeMode()) {
    if (docxBytes.includes('FAILCONV')) {
      throw new ApiError('Fake conversion failure (FAILCONV marker present).', 502);
    }
    // Mirror what Graph can actually do. The fake used to return a valid PDF for ANY bytes,
    // so sending it a PNG — which Graph refuses — passed the suite silently. Now a
    // mis-dispatch fails here, where a test can see it.
    if (!docxBytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      throw new ApiError('Fake conversion refused: not an Office (zip) file.', 502);
    }
    const sha = createHash('sha256').update(docxBytes).digest('hex');
    return minimalPdf(`FAKE-PDF for DOCX sha256 ${sha}`);
  }
  const res = await graphFetch(`/me/drive/items/${encodeURIComponent(itemId)}/content?format=pdf`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(`PDF conversion failed (HTTP ${res.status}): ${text.slice(0, 200)}`, 502);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Where PDF bytes live locally (preview + email attachment), content-addressed. */
const PDFS_DIR = path.join(LEGAL_DATA_DIR, 'files', 'pdfs');

export function storePdfBytes(bytes: Buffer): { sha256: string; path: string } {
  const sha = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(PDFS_DIR, { recursive: true });
  const target = path.join(PDFS_DIR, sha);
  if (!existsSync(target)) writeFileSync(target, bytes);
  return { sha256: sha, path: target };
}

export function readPdfBytes(sha256: string): Buffer {
  const target = path.join(PDFS_DIR, sha256);
  if (!existsSync(target)) throw new ApiError('PDF bytes missing from storage.', 500);
  return readFileSync(target);
}
