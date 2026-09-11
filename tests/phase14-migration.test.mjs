import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// Phase 14 — the one-time move of the client's pre-existing material into the app's folders.
//
// This runs against a live drive over documents that analyses already cite, so the test that
// matters is not "did the file end up in the right folder" — it is that moving it changed
// NOTHING ELSE. A OneDrive move preserves the item id, which is what stops the next sync
// treating the file as new, re-ingesting it, and orphaning every citation made against it.
// If that property ever breaks, the migration silently destroys the traceability the whole
// product is built on, so it is asserted byte for byte.

const OFFICIAL = '1. Documentos oficiais Barraqueiro';
const drive = () => path.join(testDataDir(), 'fake-onedrive');
const onDrive = (relative) => existsSync(path.join(drive(), relative));

function put(relative, contents = 'conteúdo') {
  const target = path.join(drive(), relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

let jar;
const plan = async () => (await api('/api/library/migration', { jar })).data;
const migrate = async (ids) =>
  (await api('/api/library/migration', { method: 'POST', body: { ids }, jar })).data;
const list = async (params = '') => (await api(`/api/library/list${params}`, { jar })).data;
/**
 * The document endpoint answers `{ok, document, pages}`. Flattened here on purpose: reading
 * `.driveItemId` off the raw payload silently yields undefined, and an id assertion that
 * compares undefined to undefined passes while proving nothing — which is exactly what this
 * suite exists to catch.
 */
const detail = async (documentId) => {
  const { data } = await api(`/api/library/documents/${documentId}`, { jar });
  assert.equal(data.ok, true, JSON.stringify(data));
  assert.ok(data.document.driveItemId, 'the payload really carries a drive item id');
  return { ...data.document, pages: data.pages };
};
const at = async (folder) => list(`?path=${encodeURIComponent(folder)}`);
const itemNamed = (payload, name) => payload.items.find((item) => item.name === name);

/** Ingestion runs in the background after a sync; the citation check needs its output. */
// Waits for a SETTLED document, not merely one with pages: ingestion writes pages before it
// finishes, so returning at the first page captured a state still in flight, and comparing
// that snapshot to the state after the move failed whenever ingestion finished in between.
async function waitForPages(documentId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const data = await detail(documentId);
    if (data.pages?.length > 0 && (data.state === 'indexed' || data.state === 'failed')) return data;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`document ${documentId} never settled`);
}

describe('phase 14 — arranging the legacy library', () => {
  before(async () => {
    await startServer();
    jar = await loginAdmin();
    await api('/api/msgraph/folder', {
      method: 'POST',
      body: { folderId: 'fake-root', folderName: 'fake-onedrive' },
      jar,
    });

    // The shape a real install has before this migration: the client's own folders and
    // loose files sitting at the library root, beside the folders the app created.
    put(
      'Contratos/Concessão.pdf',
      readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'nota-interna-transparencia-salarial.pdf')),
    );
    put('Contratos/Antigo/Minuta.pdf');
    put('Nota.pdf');
    put('Antigos/Parecer.pdf');
    // …and one name that is already taken at the destination, which is the case the
    // migration must refuse to resolve on its own.
    put(`${OFFICIAL}/Antigos/Anterior.pdf`);
    await api('/api/library/sync', { method: 'POST', jar });
  });

  after(async () => {
    await stopServer();
  });

  it('plans the client’s own top-level items, and none of the app’s folders', async () => {
    const current = await plan();
    assert.equal(current.ok, true, JSON.stringify(current));
    assert.equal(current.state, 'pending');

    assert.ok(itemNamed(current, 'Contratos'), 'a top-level client folder is listed');
    assert.ok(itemNamed(current, 'Nota.pdf'), 'a file at the library root is listed');

    // The three folders the app creates are structure, not the client's material: moving
    // one inside another would leave ensureLibraryStructure() recreating it beside itself.
    for (const name of [OFFICIAL, '2. Templates', '3. Resultados']) {
      assert.equal(itemNamed(current, name), undefined, `${name} must never be migrated`);
    }

    // A folder is one move carrying its subtree, so the count is what travels with it.
    assert.equal(itemNamed(current, 'Contratos').documents, 2);
    assert.equal(itemNamed(current, 'Contratos').to, `${OFFICIAL}/Contratos`);
    assert.equal(itemNamed(current, 'Nota.pdf').from, '');
  });

  it('preserves every drive item id, so nothing re-ingests and citations still resolve', async () => {
    const before = (await at('Contratos')).files.find((f) => f.name === 'Concessão.pdf');
    const readable = await waitForPages(before.documentId);
    assert.ok(readable.pages.length > 0, 'the document was read before it moved');

    const nested = (await at('Contratos/Antigo')).files.find((f) => f.name === 'Minuta.pdf');
    const ids = {
      [before.documentId]: readable.driveItemId,
      [nested.documentId]: (await detail(nested.documentId)).driveItemId,
    };

    const run = await migrate([itemNamed(await plan(), 'Contratos').id, itemNamed(await plan(), 'Nota.pdf').id]);
    assert.equal(run.ok, true, JSON.stringify(run));
    assert.deepEqual(
      run.results.filter((r) => r.status !== 'moved'),
      [],
      'both items moved',
    );

    assert.ok(onDrive(`${OFFICIAL}/Contratos/Antigo/Minuta.pdf`), 'the drive carried the whole subtree');
    assert.ok(onDrive(`${OFFICIAL}/Nota.pdf`), 'the loose file moved too');
    assert.equal(onDrive('Contratos'), false, 'nothing was left behind at the root');

    // The property the whole migration rests on.
    for (const [documentId, driveItemId] of Object.entries(ids)) {
      const after = await detail(documentId);
      assert.equal(after.driveItemId, driveItemId, 'the drive item id survived the move unchanged');
    }

    // Same row, same pages: an analysis citing document+page still resolves.
    const moved = await detail(before.documentId);
    assert.equal(moved.path, `${OFFICIAL}/Contratos`);
    assert.deepEqual(
      moved.pages.map((p) => p.page),
      readable.pages.map((p) => p.page),
      'the extracted pages are the same pages',
    );
    assert.equal(moved.state, readable.state, 're-ingestion was never triggered');
  });

  it('leaves a name that is already taken alone, and reports the run as partial', async () => {
    const conflicting = itemNamed(await plan(), 'Antigos');
    assert.equal(conflicting.conflict, true, 'the collision is visible before anything runs');

    const run = await migrate([conflicting.id]);
    assert.equal(run.results[0].status, 'skipped', JSON.stringify(run.results));
    assert.match(run.results[0].detail, /já existe/i);

    // Both survive, in their own places — the app never merges two folders on a guess.
    assert.ok(onDrive('Antigos/Parecer.pdf'), 'the client folder is untouched');
    assert.ok(onDrive(`${OFFICIAL}/Antigos/Anterior.pdf`), 'so is the one already at the destination');
    assert.equal(run.state, 'partial', 'something moved, something is still outstanding');
  });

  it('re-runs over only what is left, and finishes', async () => {
    // Resolving the collision is the user's call; renaming is the ordinary way to do it.
    const folder = (await list()).folders.find((f) => f.name === 'Antigos');
    const renamed = await api(`/api/library/folders/${folder.folderId}`, {
      method: 'PATCH',
      body: { name: 'Antigos (2024)' },
      jar,
    });
    assert.equal(renamed.data.ok, true, JSON.stringify(renamed.data));

    // The plan is recomputed from current state, never stored — so what already moved is
    // simply not in it any more, and a re-run is safe rather than merely idempotent.
    const remaining = await plan();
    assert.deepEqual(
      remaining.items.map((item) => item.name),
      ['Antigos (2024)'],
      'only the unresolved item is still outstanding',
    );

    const run = await migrate(remaining.items.map((item) => item.id));
    assert.equal(run.results[0].status, 'moved', JSON.stringify(run.results));
    assert.equal(run.state, 'done');
    assert.deepEqual(run.items, []);
    assert.ok(onDrive(`${OFFICIAL}/Antigos (2024)/Parecer.pdf`));

    // And the Library stops pointing at a screen with nothing left to do.
    assert.equal((await list()).migrationPending, false);
  });
});
