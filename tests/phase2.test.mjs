import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loadTsModule, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// Phase 2 — the ingestion pipeline on the real client fixtures, WITHOUT any model call
// (the harness guarantees AI is unconfigured; OCR and classification must degrade, not
// fail). Document rows are seeded directly — the delta feed is production's only writer.

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

async function insertDocRow(documentId, name) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
  const now = Date.now();
  db.prepare(
    `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
     VALUES (?, ?, ?, '', 'application/pdf', 0, 'listed', 0, ?, ?, ?)`,
  ).run(documentId, `local-${documentId}`, name, now, now, now);
  db.close();
}

async function uploadFixture(jar, documentId, fixtureName) {
  const bytes = readFileSync(path.join(FIXTURES, fixtureName));
  const headers = {
    'content-type': 'application/octet-stream',
    cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
  };
  const res = await fetch(`${BASE}/api/library/documents/${documentId}/original`, {
    method: 'PUT',
    headers,
    body: bytes,
  });
  return { status: res.status, data: await res.json() };
}

describe('phase 2 — ingestion pipeline (no model calls)', () => {
  before(async () => {
    // No drive: this suite is the ingestion pipeline WITHOUT Microsoft 365 — two of its
    // tests assert exactly what the app says when it cannot reach one.
    await startServer({ env: { LEGAL_FAKE_GRAPH: '' } });
  });
  after(async () => {
    await stopServer();
  });

  it('digital fixture: pages extracted, segments indexed, state indexed', async () => {
    const jar = await loginAdmin();
    await insertDocRow('doc_nota', 'Nota Interna Transparência Salarial.pdf');

    const upload = await uploadFixture(jar, 'doc_nota', 'nota-interna-transparencia-salarial.pdf');
    assert.equal(upload.status, 200, JSON.stringify(upload.data));
    assert.equal(upload.data.result.pageCount, 6);
    assert.equal(upload.data.result.ocrPending, 0);
    assert.ok(upload.data.result.segments > 0);
    assert.equal(upload.data.result.state, 'indexed');
    // AI unconfigured → classification skipped, said so honestly.
    assert.equal(upload.data.result.classified, false);
    assert.match(upload.data.result.detail, /classifica\u00e7\u00e3o pendente/i);

    const detail = await api('/api/library/documents/doc_nota', { jar });
    assert.equal(detail.data.document.state, 'indexed');
    assert.equal(detail.data.document.pageCount, 6);
    assert.equal(detail.data.pages.length, 6);
    assert.ok(detail.data.pages[0].text.length > 500);
    assert.equal(detail.data.pages[0].ocr, false);
  });

  // The segment index has no HTTP door of its own — the Library searches names and folders
  // (/api/library/list?q=). This is the INTERNAL index the relations engine reads to find
  // one document's title mentioned inside another, so it is exercised directly.
  it('page-anchored text carries known content and the segment index finds it', async () => {
    const jar = await loginAdmin();
    const detail = await api('/api/library/documents/doc_nota', { jar });
    const allText = detail.data.pages.map((p) => p.text).join('\n').toLowerCase();
    assert.ok(allText.includes('transpar'), 'expected the fixture to mention transparência');

    // Without this the module resolves to the developer's own data-home, not the test one.
    process.env.LEGAL_DATA_DIR = testDataDir();
    const { searchSegments } = await loadTsModule('src/lib/server/ingest/pages.ts');
    const hits = searchSegments('transparência');
    assert.ok(hits.length > 0, 'FTS must find the word');
    assert.equal(hits[0].documentId, 'doc_nota');
    assert.ok(hits[0].page >= 1);

    assert.equal(searchSegments('zzzznadaexiste').length, 0);

    // FTS syntax cannot be injected through the query.
    assert.doesNotThrow(() => searchSegments('" OR NEAR('));
  });

  it('scanned fixture: OCR-pending degradation, no segments, honest state', async () => {
    const jar = await loginAdmin();
    await insertDocRow('doc_codigo', 'Código de Conduta.pdf');

    const upload = await uploadFixture(jar, 'doc_codigo', 'codigo-conduta.pdf');
    assert.equal(upload.status, 200, JSON.stringify(upload.data));
    assert.equal(upload.data.result.pageCount, 12);
    assert.equal(upload.data.result.ocrPending, 12);
    assert.equal(upload.data.result.ocrDone, 0);
    assert.equal(upload.data.result.segments, 0);
    // Briefing §6: pending OCR is an ALERT on an indexed document, not a stuck state.
    assert.equal(upload.data.result.state, 'indexed');
    assert.match(upload.data.result.detail, /alerta de OCR/i);

    const detail = await api('/api/library/documents/doc_codigo', { jar });
    assert.equal(detail.data.pages.length, 12);
    assert.ok(detail.data.pages.every((p) => p.pendingOcr === true));
    assert.equal(detail.data.document.ocrPendingPages, 12);
  });

  it('dedup: unchanged content already indexed is a no-op; force reruns', async () => {
    const jar = await loginAdmin();
    const again = await api('/api/library/documents/doc_nota/ingest', { method: 'POST', body: {}, jar });
    assert.equal(again.data.result.skipped, true);

    const forced = await api('/api/library/documents/doc_nota/ingest', {
      method: 'POST',
      body: { force: true },
      jar,
    });
    assert.equal(forced.data.result.skipped, false);
    assert.equal(forced.data.result.state, 'indexed');
  });

  it('changed bytes re-run the pipeline under the new hash', async () => {
    const jar = await loginAdmin();
    await insertDocRow('doc_swap', 'swap.pdf');
    const first = await uploadFixture(jar, 'doc_swap', 'nota-interna-transparencia-salarial.pdf');
    assert.equal(first.data.result.pageCount, 6);
    const second = await uploadFixture(jar, 'doc_swap', 'codigo-conduta.pdf');
    assert.equal(second.data.result.pageCount, 12);
    assert.notEqual(first.data.sha256, second.data.sha256);
  });

  it('ingest without an original and without Graph fails gracefully', async () => {
    const jar = await loginAdmin();
    await insertDocRow('doc_nobytes', 'nowhere.pdf');
    const res = await api('/api/library/documents/doc_nobytes/ingest', { method: 'POST', body: {}, jar });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /not connected/i);
  });

  it('metadata is user-correctable and survives in the list', async () => {
    const jar = await loginAdmin();
    const patch = await api('/api/library/documents/doc_nota', {
      method: 'PATCH',
      body: { docType: 'internal_note', title: 'Nota Interna — Transparência Salarial', topics: ['remunerações'] },
      jar,
    });
    assert.equal(patch.data.ok, true);
    assert.equal(patch.data.document.docType, 'internal_note');
    assert.deepEqual(patch.data.document.topics, ['remunerações']);

    const list = await api('/api/library/documents', { jar });
    const row = list.data.documents.find((d) => d.documentId === 'doc_nota');
    assert.equal(row.docType, 'internal_note');
    assert.equal(row.title, 'Nota Interna — Transparência Salarial');
  });

  it('the library takes any kind of document, and says when it cannot read one', async () => {
    const jar = await loginAdmin();
    const cookie = [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ');

    // A .docx is a legitimate library document: it is stored and listed like any other.
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('PK\u0003\u0004 fake docx bytes')]), 'Minuta de contrato.docx');
    form.append('folder', '');
    const res = await fetch(`${BASE}/api/library/upload`, { method: 'POST', headers: { cookie }, body: form });
    const data = await res.json();
    assert.equal(res.status, 200, JSON.stringify(data));
    assert.equal(data.ok, true);
    assert.equal(data.document.name, 'Minuta de contrato.docx');
    // Without Graph there is no way to convert it to a PDF, so there is no text — and the
    // answer says exactly that instead of pretending the upload failed.
    assert.equal(data.result, null);
    assert.match(data.indexError, /Microsoft 365/i);

    const list = await api('/api/library/documents', { jar });
    const row = list.data.documents.find((d) => d.name === 'Minuta de contrato.docx');
    assert.ok(row, 'the document is listed in the library');

    // Deleting it takes it out of the library (nothing on OneDrive to delete here).
    const del = await api(`/api/library/documents/${row.documentId}`, { method: 'DELETE', jar });
    assert.equal(del.data.ok, true);
    assert.equal(del.data.deletedOnDrive, false);
    const after = await api('/api/library/documents', { jar });
    assert.equal(
      after.data.documents.find((d) => d.documentId === row.documentId),
      undefined,
      'a deleted document is gone from the library list',
    );
  });

  it('unknown documents 404 across the new routes', async () => {
    const jar = await loginAdmin();
    for (const [method, p, body] of [
      ['POST', '/api/library/documents/doc_nope/ingest', {}],
      ['GET', '/api/library/documents/doc_nope', undefined],
      ['PATCH', '/api/library/documents/doc_nope', { title: 'x' }],
    ]) {
      const res = await api(p, { method, body, jar });
      assert.equal(res.status, 404, `${method} ${p}`);
    }
  });
});
