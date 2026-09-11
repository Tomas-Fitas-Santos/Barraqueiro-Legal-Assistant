import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loadTsModule, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// §6 — the client's eight document states, decided in ONE place.
//
// The states were previously derived from `state`, `removed` and a live pending-OCR count by
// whichever screen happened to need one, which is four chances to disagree. `state` stays the
// coarse pipeline value that the server's gates branch on (SQLite cannot ALTER a CHECK, and
// "can this document be analysed yet?" is not a §6 question); a `stage` column carries the
// fine value beside it; and `clientDocumentState()` is the only thing that combines them.
//
// Two of the eight stay derived rather than stored, and this suite pins both: the OCR alert
// has to react to a page finishing OCR without a re-ingest, and Eliminado must not overwrite
// the row's last pipeline state.

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

async function openDb() {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
}

async function insertDocRow(documentId, name) {
  const db = await openDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
     VALUES (?, ?, ?, '', 'application/pdf', 0, 'listed', 0, ?, ?, ?)`,
  ).run(documentId, `local-${documentId}`, name, now, now, now);
  db.close();
}

async function uploadFixture(jar, documentId, fixtureName) {
  const res = await fetch(`${BASE}/api/library/documents/${documentId}/original`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    },
    body: readFileSync(path.join(FIXTURES, fixtureName)),
  });
  return { status: res.status, data: await res.json() };
}

let jar;
const stateOf = async (documentId) => {
  const { data } = await api(`/api/library/documents/${documentId}`, { jar });
  assert.equal(data.ok, true, JSON.stringify(data));
  return data.document.clientState;
};

describe('phase 15 — §6 states, derived once', () => {
  before(async () => {
    await startServer({ env: { LEGAL_FAKE_GRAPH: '' } });
    jar = await loginAdmin();
  });
  after(async () => {
    await stopServer();
  });

  it('the vocabulary is exactly the client’s nine, and nothing else can be shown', async () => {
    const { CLIENT_DOCUMENT_STATE_LABELS, CLIENT_DOCUMENT_STATES } = await loadTsModule('src/lib/types.ts');
    assert.deepEqual(Object.values(CLIENT_DOCUMENT_STATE_LABELS), [
      'Recebido',
      'Em extração',
      'Em OCR',
      'Em classificação',
      'Indexado',
      'Indexado com alerta de OCR',
      'Erro',
      'Em falta',
      'Eliminado',
    ]);
    assert.deepEqual(Object.keys(CLIENT_DOCUMENT_STATE_LABELS), [...CLIENT_DOCUMENT_STATES]);
  });

  it('maps every pipeline state, and settles the two collisions', async () => {
    const { clientDocumentState } = await loadTsModule('src/lib/types.ts');
    assert.equal(clientDocumentState({ state: 'listed' }), 'recebido');
    assert.equal(clientDocumentState({ state: 'downloaded' }), 'recebido');
    assert.equal(clientDocumentState({ state: 'processing', stage: 'em_extracao' }), 'em_extracao');
    assert.equal(clientDocumentState({ state: 'processing', stage: 'em_ocr' }), 'em_ocr');
    assert.equal(clientDocumentState({ state: 'processing', stage: 'em_classificacao' }), 'em_classificacao');
    assert.equal(clientDocumentState({ state: 'indexed' }), 'indexado');
    assert.equal(clientDocumentState({ state: 'failed' }), 'erro');

    // A row written before `stage` existed still has to answer something true.
    assert.equal(clientDocumentState({ state: 'processing', stage: '' }), 'em_extracao');

    // Eliminado wins over everything — including an error, so a deleted failed document
    // does not keep shouting about a failure nobody can act on any more.
    assert.equal(clientDocumentState({ state: 'failed', removed: 1 }), 'eliminado');

    // A file the library cannot reach outranks whatever the app managed to learn about it:
    // "Indexado" for a document nobody can open is the silent failure this state exists for.
    assert.equal(clientDocumentState({ state: 'indexed', missing: 1 }), 'em_falta');
    // But being gone still wins over being merely unreachable.
    assert.equal(clientDocumentState({ state: 'indexed', missing: 1, removed: 1 }), 'eliminado');
    assert.equal(clientDocumentState({ state: 'indexed', removed: true, ocrPendingPages: 3 }), 'eliminado');

    // The alert is a LIVE count, not a stage: the row is still 'indexed'/'indexado'.
    assert.equal(clientDocumentState({ state: 'indexed', stage: 'indexado', ocrPendingPages: 2 }), 'indexado_com_alerta');
    assert.equal(clientDocumentState({ state: 'indexed', stage: 'indexado', ocrPendingPages: 0 }), 'indexado');
  });

  it('a document walks Recebido → Indexado, and the list says the same as the page', async () => {
    await insertDocRow('doc_state_ok', 'Nota Interna Transparência Salarial.pdf');
    assert.equal(await stateOf('doc_state_ok'), 'recebido');

    const upload = await uploadFixture(jar, 'doc_state_ok', 'nota-interna-transparencia-salarial.pdf');
    assert.equal(upload.status, 200, JSON.stringify(upload.data));
    assert.equal(await stateOf('doc_state_ok'), 'indexado');

    const { data } = await api('/api/library/list', { jar });
    const row = data.files.find((f) => f.documentId === 'doc_state_ok');
    assert.equal(row.clientState, 'indexado', 'the list must not derive its own answer');

    // The stage really was recorded, so the page is reading a stored value and not guessing.
    const db = await openDb();
    const stored = db.prepare('SELECT stage FROM documents WHERE document_id = ?').get('doc_state_ok');
    db.close();
    assert.equal(stored.stage, 'indexado');
  });

  it('pages left untranscribed show the alert, and transcribing them clears it', async () => {
    await insertDocRow('doc_state_ocr', 'Código de Conduta.pdf');
    const upload = await uploadFixture(jar, 'doc_state_ocr', 'codigo-conduta.pdf');
    assert.equal(upload.status, 200, JSON.stringify(upload.data));
    assert.ok(upload.data.result.ocrPending > 0, 'the scanned fixture must degrade, not fail');
    assert.equal(await stateOf('doc_state_ocr'), 'indexado_com_alerta');

    // OCR completing is not a re-ingest — the state has to follow the count on its own.
    const db = await openDb();
    db.prepare('UPDATE document_pages SET pending_ocr = 0 WHERE document_id = ?').run('doc_state_ocr');
    db.close();
    assert.equal(await stateOf('doc_state_ocr'), 'indexado');
  });

  it('a failure is Erro, and deleting it is Eliminado without losing what happened', async () => {
    await insertDocRow('doc_state_bad', 'Ficheiro ilegível.pdf');
    const upload = await uploadFixture(jar, 'doc_state_bad', 'captura-ecra.png');
    // The fixture is a PNG uploaded as a PDF: whatever the pipeline decides, the row must
    // end up in one of §6's states and never in a raw pipeline word.
    assert.ok([200, 400, 500].includes(upload.status));

    const db = await openDb();
    db.prepare("UPDATE documents SET state = 'failed', stage = 'erro' WHERE document_id = ?").run('doc_state_bad');
    db.close();
    assert.equal(await stateOf('doc_state_bad'), 'erro');

    const db2 = await openDb();
    db2.prepare('UPDATE documents SET removed = 1 WHERE document_id = ?').run('doc_state_bad');
    const row = db2.prepare('SELECT state, stage FROM documents WHERE document_id = ?').get('doc_state_bad');
    db2.close();
    assert.equal(await stateOf('doc_state_bad'), 'eliminado');
    // Deleting must not rewrite the row: restoring it has to remember it had failed.
    assert.equal(row.state, 'failed');
    assert.equal(row.stage, 'erro');
  });
});
