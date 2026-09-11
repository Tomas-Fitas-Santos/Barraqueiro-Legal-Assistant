import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// Phase 14 — creating, renaming, moving and deleting things in the client's library.
//
// These are the first operations that WRITE to the client's own OneDrive, so what matters
// most is what they refuse to do: change a file's extension, touch a folder the app
// recreates, drop a client file into the app's output folder, or lose a citation.

const drive = () => path.join(testDataDir(), 'fake-onedrive');
const onDrive = (relative) => existsSync(path.join(drive(), relative));

function put(relative, contents = 'conteúdo') {
  const target = path.join(drive(), relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

let jar;
const list = async (params = '') => (await api(`/api/library/list${params}`, { jar })).data;
const findFile = async (name, params = '') => (await list(params)).files.find((f) => f.name === name);
const findFolder = async (name, params = '') => (await list(params)).folders.find((f) => f.name === name);

/** Ingestion runs in the background after a sync; a test that reads its output must wait. */
async function waitForPages(documentId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const detail = await api(`/api/library/documents/${documentId}`, { jar });
    if (detail.data.pages?.length > 0) return detail.data;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`document ${documentId} never produced pages`);
}

describe('phase 14 — managing the library', () => {
  before(async () => {
    await startServer();
    jar = await loginAdmin();
    await api('/api/msgraph/folder', {
      method: 'POST',
      body: { folderId: 'fake-root', folderName: 'fake-onedrive' },
      jar,
    });
    put(
      'Contratos/Concessão.pdf',
      readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'nota-interna-transparencia-salarial.pdf')),
    );
    put('Contratos/Antigo/Minuta.pdf');
    await api('/api/library/sync', { method: 'POST', jar });
  });

  after(async () => {
    await stopServer();
  });

  it('creates a folder on the drive, and refuses a name that is taken', async () => {
    const created = await api('/api/library/folders', {
      method: 'POST',
      body: { parentPath: '', name: 'Pareceres' },
      jar,
    });
    assert.equal(created.data.ok, true, JSON.stringify(created.data));
    assert.equal(created.data.syncedToDrive, true);
    assert.ok(onDrive('Pareceres'), 'the folder exists on the drive, not just in the mirror');

    const again = await api('/api/library/folders', { method: 'POST', body: { parentPath: '', name: 'Pareceres' }, jar });
    assert.equal(again.status, 409, JSON.stringify(again.data));

    // The naming rules are the drive's, checked before the round trip.
    const bad = await api('/api/library/folders', { method: 'POST', body: { parentPath: '', name: 'a/b' }, jar });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /não pode conter/i);
  });

  it('renames a folder and carries its whole subtree with it', async () => {
    const folder = await findFolder('Contratos');
    const res = await api(`/api/library/folders/${folder.folderId}`, {
      method: 'PATCH',
      body: { name: 'Contratos e Concessões' },
      jar,
    });
    assert.equal(res.data.ok, true, JSON.stringify(res.data));
    assert.ok(res.data.movedDocuments >= 2, 'every document under it was rewritten');
    assert.ok(onDrive('Contratos e Concessões/Antigo/Minuta.pdf'), 'the drive moved too');

    const inside = await list('?path=' + encodeURIComponent('Contratos e Concessões'));
    assert.ok(inside.files.some((f) => f.name === 'Concessão.pdf'));
    assert.deepEqual(inside.folders.map((f) => f.name), ['Antigo']);

    // The nested folder's own path was rewritten, not just the top one.
    const nested = await list('?path=' + encodeURIComponent('Contratos e Concessões/Antigo'));
    assert.deepEqual(nested.files.map((f) => f.name), ['Minuta.pdf']);
  });

  it('refuses to change a file’s extension', async () => {
    const file = await findFile('Concessão.pdf', '?path=' + encodeURIComponent('Contratos e Concessões'));
    const res = await api(`/api/library/documents/${file.documentId}`, {
      method: 'PATCH',
      body: { name: 'Concessão.txt' },
      jar,
    });
    // Silently allowing this would invalidate the detected format, the PDF rendition and
    // every citation resolved through it.
    assert.equal(res.status, 400, JSON.stringify(res.data));
    assert.match(res.data.error, /extensão/i);

    const ok = await api(`/api/library/documents/${file.documentId}`, {
      method: 'PATCH',
      body: { name: 'Concessão Rodoviária.pdf' },
      jar,
    });
    assert.equal(ok.data.ok, true, JSON.stringify(ok.data));
    assert.ok(onDrive('Contratos e Concessões/Concessão Rodoviária.pdf'));
  });

  it('moving a file into the Templates folder changes what it is — without losing its text', async () => {
    const file = await findFile('Concessão Rodoviária.pdf', '?path=' + encodeURIComponent('Contratos e Concessões'));
    const before = await waitForPages(file.documentId);
    assert.ok(before.pages.length > 0, 'it has extracted text to lose');

    const res = await api(`/api/library/documents/${file.documentId}`, {
      method: 'PATCH',
      body: { folderPath: '2. Templates/Resumo documental' },
      jar,
    });
    assert.equal(res.data.ok, true, JSON.stringify(res.data));
    assert.match(res.data.note, /deixa de ser material de origem/i);

    // Pages are KEPT on purpose: an analysis that already cited this document has to keep
    // resolving those citations. Deleting them would be irreversible.
    const after = await api(`/api/library/documents/${file.documentId}`, { jar });
    assert.equal(after.data.pages.length, before.pages.length);
  });

  it('refuses to put a client file in the app’s own output folder', async () => {
    const file = await findFile('Minuta.pdf', '?path=' + encodeURIComponent('Contratos e Concessões/Antigo'));
    const res = await api(`/api/library/documents/${file.documentId}`, {
      method: 'PATCH',
      body: { folderPath: '3. Documentos gerados/Resumo documental' },
      jar,
    });
    assert.equal(res.status, 400, JSON.stringify(res.data));
    assert.match(res.data.error, /documentos produzidos pela aplicação/i);
  });

  it('refuses to rename or delete a folder the app maintains', async () => {
    const templates = await findFolder('2. Templates');
    const renamed = await api(`/api/library/folders/${templates.folderId}`, {
      method: 'PATCH',
      body: { name: 'Modelos' },
      jar,
    });
    assert.equal(renamed.status, 400);
    assert.match(renamed.data.error, /pasta da aplicação/i);

    const deleted = await api(`/api/library/folders/${templates.folderId}`, { method: 'DELETE', jar });
    assert.equal(deleted.status, 400, 'the app would just recreate it, leaving two');
  });

  it('says what a delete would take, then takes exactly that', async () => {
    const folder = await findFolder('Contratos e Concessões');
    const impact = await api(`/api/library/folders/${folder.folderId}`, { jar });
    assert.equal(impact.data.ok, true);
    // Graph's folder delete is always recursive, so the count is the point of the dialog.
    assert.ok(impact.data.impact.documents >= 1, JSON.stringify(impact.data.impact));
    assert.ok(impact.data.impact.folders >= 1);

    const res = await api(`/api/library/folders/${folder.folderId}`, { method: 'DELETE', jar });
    assert.equal(res.data.ok, true, JSON.stringify(res.data));
    assert.equal(res.data.deletedOnDrive, true);
    assert.equal(res.data.documentsRemoved, impact.data.impact.documents);
    assert.equal(onDrive('Contratos e Concessões'), false, 'gone from the drive');

    const root = await list();
    assert.equal(root.folders.some((f) => f.name === 'Contratos e Concessões'), false);
    // Still resolvable, though — a citation made against a deleted document must not break.
    const withRemoved = await api('/api/library/documents?includeRemoved=1', { jar });
    assert.ok(withRemoved.data.documents.some((d) => d.name === 'Minuta.pdf'));
  });
});
