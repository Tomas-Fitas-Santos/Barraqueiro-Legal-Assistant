import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// Phase 18 — the library moves.
//
// Somebody connects a DIFFERENT Microsoft account, or picks a different root folder in the
// same one. Every OneDrive id the app cached — the library folder itself included — now
// names something on a drive it cannot reach. The property under test is that this is
// survivable and quiet: the folder structure is rebuilt without being asked, no document is
// deleted, and the ONE question the user is put is whether to bring the documents across.
//
// The fake drive models two accounts as two directories with disjoint ids, so a stale id
// cannot accidentally resolve on the new drive and hide the bug.

const driveOf = (account) =>
  path.join(testDataDir(), account === 'a' ? 'fake-onedrive' : `fake-onedrive-${account}`);

function put(account, relative, contents) {
  const target = path.join(driveOf(account), relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

const STRUCTURE = ['1. Documentos oficiais Barraqueiro', '2. Templates', '3. Resultados'];

/** Sign the fake Graph in as a given account, through the real OAuth callback route. */
async function signInAs(account, jar) {
  const authorize = await api('/api/msgraph/authorize', { method: 'POST', jar });
  assert.equal(authorize.data.ok, true, JSON.stringify(authorize.data));
  const state = new URL(authorize.data.authorizationUrl).searchParams.get('state');
  const callback = await api(`/api/msgraph/callback?code=fake:${account}&state=${state}`, {
    jar,
    redirect: 'manual',
  });
  return callback;
}

let jar;

describe('phase 18 — the library moves to another account or folder', () => {
  before(async () => {
    await startServer();
    jar = await loginAdmin();
    // The sign-in flow is the real one even against the fake drive, so it wants a real app
    // registration to build the authorize URL from.
    await api('/api/msgraph/config', {
      method: 'PATCH',
      body: { tenantId: 'consumers', clientId: 'fake-client', clientSecret: 'fake-secret' },
      jar,
    });
  });

  after(async () => {
    await stopServer();
  });

  it('picking the library folder migrates the old results name and builds the structure', async () => {
    await signInAs('a', jar);
    // A prior structure pass may already have made the new empty shell. Migration may
    // replace that shell, but must preserve the old root and every item below it.
    mkdirSync(path.join(driveOf('a'), '3. Resultados', 'Resumo documental'), { recursive: true });
    mkdirSync(path.join(driveOf('a'), '3. Resultados', 'Revisão e Atualização'), { recursive: true });
    put('a', '3. Documentos gerados/Resumo documental/resultado-anterior.txt', 'preservado');
    const chosen = await api('/api/msgraph/folder', {
      method: 'POST',
      body: { folderId: 'fake-root', folderName: 'fake-onedrive' },
      jar,
    });
    assert.equal(chosen.data.ok, true, JSON.stringify(chosen.data));
    for (const folder of STRUCTURE) {
      assert.ok(existsSync(path.join(driveOf('a'), folder)), `${folder} must exist in the chosen library`);
    }
    assert.equal(existsSync(path.join(driveOf('a'), '3. Documentos gerados')), false, 'the former root was renamed, not duplicated');
    assert.equal(
      readFileSync(path.join(driveOf('a'), '3. Resultados', 'Resumo documental', 'resultado-anterior.txt'), 'utf8'),
      'preservado',
      'renaming the folder preserves every existing result',
    );
  });

  it('a document in the library is known to the app', async () => {
    put('a', '1. Documentos oficiais Barraqueiro/Regulamento.txt', 'texto do regulamento');
    await api('/api/library/sync', { method: 'POST', jar });
    const list = await api('/api/library/list?path=1.%20Documentos%20oficiais%20Barraqueiro', { jar });
    const names = list.data.files.map((f) => f.name);
    assert.ok(names.includes('Regulamento.txt'), JSON.stringify(names));
  });

  it('connecting another account forgets the previous drive instead of trusting it', async () => {
    await signInAs('b', jar);
    const config = await api('/api/msgraph/config', { jar });
    // The library folder belonged to the OLD drive. Keeping it would leave the app
    // "configured" against a folder this account cannot open — which is how a switched
    // account used to surface as a bare HTTP 404 from inside PDF conversion.
    assert.equal(config.data.libraryConfigured, false, JSON.stringify(config.data));
    assert.equal(config.data.accountEmail, 'conta-b@exemplo.pt');
  });

  it('the documents are not deleted — they are missing, and the move asks one question', async () => {
    const pending = await api('/api/library/transfer', { jar });
    assert.equal(pending.data.ok, true);
    assert.ok(pending.data.move, 'a move with documents left behind must be pending');
    assert.equal(pending.data.move.sameAccount, false);
    assert.equal(pending.data.move.documentCount, 2, 'the official document and renamed historic result are both preserved');
    assert.equal(pending.data.move.fromAccountEmail, 'conta-a@exemplo.pt');
  });

  it('the new account gets the same structure, again without being asked', async () => {
    const chosen = await api('/api/msgraph/folder', {
      method: 'POST',
      body: { folderId: 'fake-root-b', folderName: 'fake-onedrive-b' },
      jar,
    });
    assert.equal(chosen.data.ok, true, JSON.stringify(chosen.data));
    for (const folder of STRUCTURE) {
      assert.ok(existsSync(path.join(driveOf('b'), folder)), `${folder} must exist in the new library`);
    }
  });

  it('transferring uploads the documents from the app’s own store, not from the old account', async () => {
    const done = await api('/api/library/transfer', { method: 'POST', body: { decision: 'transfer' }, jar });
    assert.equal(done.data.ok, true, JSON.stringify(done.data));
    assert.deepEqual(done.data.report.failures, [], 'one report, and nothing in it');
    assert.equal(done.data.report.transferred, 1, 'only source material is reconstructed in another account');
    assert.equal(done.data.report.stillMissing, 1, 'the historical result remains accounted for in the old account');
    assert.equal(
      readFileSync(path.join(driveOf('a'), '3. Resultados', 'Resumo documental', 'resultado-anterior.txt'), 'utf8'),
      'preservado',
      'historic results remain untouched in the previous account',
    );
    const moved = path.join(driveOf('b'), '1. Documentos oficiais Barraqueiro', 'Regulamento.txt');
    assert.ok(existsSync(moved), 'the document must now exist in the new account');
    assert.equal(readFileSync(moved, 'utf8'), 'texto do regulamento', 'byte-for-byte, from the local store');

    // The source was transferred. The old result has no local copy, so it is still honestly
    // accounted for until the user explicitly chooses to leave that historical file behind.
    const partial = await api('/api/library/transfer', { jar });
    assert.equal(partial.data.move.documentCount, 1);
    assert.equal(partial.data.move.transferableCount, 0);
    const left = await api('/api/library/transfer', {
      method: 'POST', body: { decision: 'skip', confirmDocumentCount: 1 }, jar,
    });
    assert.equal(left.data.ok, true, JSON.stringify(left.data));
    const after = await api('/api/library/transfer', { jar });
    assert.equal(after.data.move, null);
  });

  it('the document keeps its identity across the move', async () => {
    const list = await api('/api/library/list?path=1.%20Documentos%20oficiais%20Barraqueiro', { jar });
    const file = list.data.files.find((f) => f.name === 'Regulamento.txt');
    assert.ok(file, 'the transferred document is listed in the new library');
    assert.equal(list.data.files.length, 1, 'and it is ONE document, not a second copy');
  });

  it('a document put back into the new library returns to the row it always had', async () => {
    const before = await api('/api/library/list?path=1.%20Documentos%20oficiais%20Barraqueiro', { jar });
    const original = before.data.files.find((f) => f.name === 'Regulamento.txt');

    // Move again, and this time put the file into the new library by hand instead of
    // transferring it — the shape of "the client sorted it out themselves".
    await signInAs('c', jar);
    await api('/api/msgraph/folder', {
      method: 'POST',
      body: { folderId: 'fake-root-c', folderName: 'fake-onedrive-c' },
      jar,
    });
    put('c', '1. Documentos oficiais Barraqueiro/Regulamento.txt', 'texto do regulamento');
    await api('/api/library/sync', { method: 'POST', jar });

    const after = await api('/api/library/list?path=1.%20Documentos%20oficiais%20Barraqueiro', { jar });
    const returned = after.data.files.find((f) => f.name === 'Regulamento.txt');
    assert.ok(returned, 'the document is in the library again');
    assert.equal(returned.documentId, original.documentId, 'the SAME row — not a second document');
    assert.notEqual(returned.clientState, 'em_falta', 'and it is no longer missing');
    assert.equal(after.data.files.length, 1, 'the returning file did not become a duplicate');
  });

  it('leaving documents behind requires a confirmation that names the count', async () => {
    put('c', '1. Documentos oficiais Barraqueiro/Politica.txt', 'texto da política');
    await api('/api/library/sync', { method: 'POST', jar });

    await signInAs('d', jar);
    const pending = await api('/api/library/transfer', { jar });
    assert.ok(pending.data.move, JSON.stringify(pending.data));
    const count = pending.data.move.documentCount;

    const vague = await api('/api/library/transfer', { method: 'POST', body: { decision: 'skip' }, jar });
    assert.equal(vague.status, 409, 'a bare "skip" must not be enough to abandon documents');

    const confirmed = await api('/api/library/transfer', {
      method: 'POST',
      body: { decision: 'skip', confirmDocumentCount: count },
      jar,
    });
    assert.equal(confirmed.data.ok, true, JSON.stringify(confirmed.data));
  });
});
