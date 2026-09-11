import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// Phase 14 — the Library list.
//
// This replaces an endpoint that returned EVERY document in the library on every page load,
// four times per user journey. The list is now one folder at a time, paginated by keyset so
// a sync inserting rows mid-scroll cannot shift the page under the reader.

const drive = () => path.join(testDataDir(), 'fake-onedrive');

function put(relative, contents = 'conteúdo') {
  const target = path.join(drive(), relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

const list = async (jar, params = '') => (await api(`/api/library/list${params}`, { jar })).data;

let jar;

describe('phase 14 — the Library list', () => {
  before(async () => {
    await startServer();
    jar = await loginAdmin();
    await api('/api/msgraph/folder', {
      method: 'POST',
      body: { folderId: 'fake-root', folderName: 'fake-onedrive' },
      jar,
    });
    // A real PDF: the download route refuses to serve a text file as one, correctly.
    put(
      'Contratos/Concessão Rodoviária.pdf',
      readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'nota-interna-transparencia-salarial.pdf')),
    );
    put('Contratos/2026/Acordo Coletivo.pdf');
    put('Política de Privacidade.pdf');
    for (let i = 1; i <= 5; i += 1) put(`Contratos/Anexo ${i}.pdf`, `anexo ${i}`);
    await api('/api/library/sync', { method: 'POST', jar });
  });

  after(async () => {
    await stopServer();
  });

  it('serves one folder: its subfolders, its files, and the way back', async () => {
    const root = await list(jar);
    assert.equal(root.path, '');
    assert.deepEqual(root.breadcrumb, [{ name: 'Biblioteca', path: '' }]);

    // Only DIRECT children — the old endpoint returned the whole library flat.
    const folderNames = root.folders.map((f) => f.name);
    assert.ok(folderNames.includes('Contratos'), JSON.stringify(folderNames));
    assert.equal(folderNames.includes('2026'), false, 'a nested folder is not a root child');
    assert.deepEqual(root.files.map((f) => f.name), ['Política de Privacidade.pdf']);

    const inside = await list(jar, '?path=Contratos');
    assert.deepEqual(inside.breadcrumb.map((c) => c.name), ['Biblioteca', 'Contratos']);
    assert.deepEqual(inside.folders.map((f) => f.name), ['2026']);
    assert.equal(inside.files.length, 6, 'the five anexos plus the concession');
  });

  it('a folder carries what is beneath it, at every level', async () => {
    const root = await list(jar);
    const contratos = root.folders.find((f) => f.name === 'Contratos');
    // 6 files directly in it plus 1 in 2026 — a folder counts its whole subtree, which is
    // what makes "N itens" mean the same thing it means in OneDrive.
    assert.equal(contratos.itemCount, 7);
    assert.ok(contratos.pendingCount > 0, 'and how much of it still needs processing');
  });

  it('pages by keyset: no gaps, no repeats, and the total describes the folder', async () => {
    const seen = [];
    let cursor = '';
    let total = 0;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await list(jar, `?path=Contratos&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...page.files.map((f) => f.name));
      total = page.totals.files;
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    assert.equal(seen.length, 6);
    assert.equal(new Set(seen).size, 6, 'no document appears on two pages');
    // The total is the FOLDER's count, not the page's — it used to shrink as you scrolled,
    // because it was computed with the cursor filter still applied.
    assert.equal(total, 6);
  });

  it('the filter matches names, ignores accents, and keeps folders visible', async () => {
    // Typing without accents must find the accented name. The old filter did a raw
    // lowercase `includes`, so this returned nothing.
    const found = await list(jar, '?q=concessao');
    assert.deepEqual(found.files.map((f) => f.name), ['Concessão Rodoviária.pdf']);

    const accented = await list(jar, '?q=' + encodeURIComponent('Concessão'));
    assert.equal(accented.files.length, 1, 'and typing the accent finds it too');

    // Folders match by name and stay in the results — the old filter hid every folder the
    // moment you typed, so you could not filter down to one.
    const folders = await list(jar, '?q=contrat');
    assert.deepEqual(folders.folders.map((f) => f.name), ['Contratos']);
  });

  it('sorts on the server, both directions', async () => {
    const asc = await list(jar, '?path=Contratos&sort=name&dir=asc');
    const desc = await list(jar, '?path=Contratos&sort=name&dir=desc');
    assert.deepEqual([...asc.files.map((f) => f.name)].reverse(), desc.files.map((f) => f.name));
  });

  it('serves a PDF as a PDF, whatever the drive called it', async () => {
    const inside = await list(jar, '?path=Contratos');
    const doc = inside.files.find((f) => f.name.includes('Concess'));
    const res = await fetch(
      `${(await import('./helpers.mjs')).BASE}/api/library/documents/${doc.documentId}/download?inline=1&as=pdf`,
      { headers: { cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } },
    );
    // The preview iframe shows a blank pane for anything else, and a document whose OneDrive
    // mime is missing or wrong is common enough to matter.
    assert.equal(res.headers.get('content-type'), 'application/pdf');
  });
});

describe('phase 14 — the Library without OneDrive', () => {
  let localJar;

  before(async () => {
    // No drive at all — a supported way to run this app, and the case where nothing else
    // would ever write the folder table.
    await startServer({ env: { LEGAL_FAKE_GRAPH: '' } });
    localJar = await loginAdmin();
  });

  after(async () => {
    await stopServer();
  });

  it('still shows the app’s own folders', async () => {
    const root = (await api('/api/library/list', { jar: localJar })).data;
    assert.equal(root.configured, false);
    const names = root.folders.map((f) => f.name);
    // The old screen hard-coded these into the UI. They are real rows now, and a local-only
    // install has no sync to create them — so the list has to seed them itself.
    for (const folder of ['1. Documentos oficiais Barraqueiro', '2. Templates', '3. Resultados']) {
      assert.ok(names.includes(folder), `${folder} missing from ${JSON.stringify(names)}`);
    }
  });
});
