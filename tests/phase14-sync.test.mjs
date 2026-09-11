import assert from 'node:assert/strict';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// Phase 14 — the delta sync, tested for the first time.
//
// `syncLibrary()`, `relativePath()` and `drive_folders` had ZERO coverage: every suite ran
// with `isLibraryConfigured()` false, so the sync returned at its first line. That is why
// three real bugs lived in there — a moved file silently re-filed at the library root, a
// deleted folder leaving its documents behind, and a folder table that was empty on any
// install without OneDrive.
//
// The fake drive is a directory tree with stable item ids. Ids deliberately do not derive
// from the path, because the property that matters most here is that MOVING a file keeps
// its identity — nothing re-ingests, no citation breaks.

const drive = () => path.join(testDataDir(), 'fake-onedrive');

function put(relative, contents = 'conteúdo') {
  const target = path.join(drive(), relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

async function sync(jar) {
  const res = await api('/api/library/sync', { method: 'POST', jar });
  assert.equal(res.data.ok, true, JSON.stringify(res.data));
  return res.data;
}

async function docs(jar) {
  const res = await api('/api/library/documents', { jar });
  return res.data;
}

const byName = (list, name) => list.find((d) => d.name === name);

let jar;

describe('phase 14 — the delta sync (fake drive)', () => {
  before(async () => {
    await startServer();
    jar = await loginAdmin();
    // Choosing the folder is a real step even against the fake, exactly as it is against a
    // tenant — which is what lets the degradation suites still test an unconfigured install.
    const chosen = await api('/api/msgraph/folder', {
      method: 'POST',
      body: { folderId: 'fake-root', folderName: 'fake-onedrive' },
      jar,
    });
    assert.equal(chosen.data.ok, true, JSON.stringify(chosen.data));
  });

  after(async () => {
    await stopServer();
  });

  it('mirrors a folder tree, parents before children', async () => {
    put('Contratos/2026/Acordo.pdf');
    put('Politica.pdf');
    const result = await sync(jar);
    assert.ok(result.upserted >= 2, JSON.stringify(result));

    const list = await docs(jar);
    assert.equal(byName(list.documents, 'Acordo.pdf').path, 'Contratos/2026');
    assert.equal(byName(list.documents, 'Politica.pdf').path, '');

    // Folders are rows now, not just prefixes inferred from a document's path.
    const paths = list.folders.map((f) => f.path);
    assert.ok(paths.includes('Contratos'), JSON.stringify(paths));
    assert.ok(paths.includes('Contratos/2026'));
  });

  it('a file moved on the drive follows its folder — and keeps its identity', async () => {
    const before = byName((await docs(jar)).documents, 'Politica.pdf');
    assert.equal(before.path, '');

    renameSync(path.join(drive(), 'Politica.pdf'), path.join(drive(), 'Contratos/Politica.pdf'));
    await sync(jar);

    const after = byName((await docs(jar)).documents, 'Politica.pdf');
    assert.equal(after.path, 'Contratos', 'the document follows the file');
    // The whole point: same drive item, so the same document row — nothing re-ingested and
    // any citation against it still resolves.
    assert.equal(after.documentId, before.documentId);
    assert.equal(after.driveItemId, before.driveItemId);
  });

  it('an incremental delta that does not re-list the parents never re-files at the root', async () => {
    // This is the bug. An incremental pass returns a changed file WITHOUT its parent
    // folders, the in-memory map is empty, and the old code fell back to '' — quietly
    // moving the user's document to the library root.
    put('Contratos/2026/Acordo.pdf', 'conteúdo revisto');
    await sync(jar);

    const moved = byName((await docs(jar)).documents, 'Acordo.pdf');
    assert.equal(moved.path, 'Contratos/2026', 'a changed file must stay where it lives');
  });

  it('deleting a folder on the drive removes what was inside it', async () => {
    const before = (await docs(jar)).documents.filter((d) => d.path.startsWith('Contratos'));
    assert.ok(before.length >= 2, 'documents to lose');

    rmSync(path.join(drive(), 'Contratos'), { recursive: true, force: true });
    await sync(jar);

    const after = (await docs(jar)).documents;
    for (const doc of before) {
      assert.equal(after.some((d) => d.documentId === doc.documentId), false, `${doc.name} must be gone`);
    }
    // Not destroyed, though: the rows are flagged, so citations made against them still
    // resolve. That is deliberate, and `?includeRemoved=1` proves it.
    const withRemoved = await api('/api/library/documents?includeRemoved=1', { jar });
    assert.ok(withRemoved.data.documents.some((d) => d.documentId === before[0].documentId));

    const folders = (await docs(jar)).folders.map((f) => f.path);
    assert.equal(folders.includes('Contratos/2026'), false, 'subfolders go too');
  });

  it('the app’s own folders exist on the drive and are not treated as documents', async () => {
    const list = await docs(jar);
    const paths = list.folders.map((f) => f.path);
    for (const folder of ['1. Documentos oficiais Barraqueiro', '2. Templates', '3. Resultados']) {
      assert.ok(paths.includes(folder), `${folder} missing from ${JSON.stringify(paths)}`);
    }
    // The published templates sync back like any file, but are never indexed.
    const template = byName(list.documents, 'nota-resumo.docx');
    if (template) {
      assert.equal(template.path, '2. Templates/Resumo documental');
      assert.notEqual(template.state, 'indexed');
    }
  });
});
