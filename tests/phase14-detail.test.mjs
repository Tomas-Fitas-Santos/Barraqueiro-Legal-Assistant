import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, loadTsModule, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// Phase 14 — the document detail page: §8's metadata, §9's relations in both directions, and
// which analyses used the document.
//
// The property that matters here is the one that used to be broken silently: a person fixes
// a wrong date, the file is later re-read, and the classifier writes its own answer back over
// theirs with nothing on screen to say so. So the test does not stop at "the PATCH worked" —
// it drives the classifier writer directly afterwards and asserts that the corrected fields
// were left alone while every field nobody touched did refresh. Asserting only one half of
// that would pass on an implementation that simply ignores the classifier.

const dbPath = () => path.join(testDataDir(), 'legal-assistant.sqlite');

async function openDb() {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(dbPath());
}

async function insertDoc(documentId, name, extra = {}) {
  const db = await openDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'application/pdf', 0, 'indexed', 0, ?, ?, ?)`,
  ).run(documentId, `local-${documentId}`, name, extra.path || '', now, now, now);
  db.close();
}

let jar;
const detail = async (documentId) => {
  const { data } = await api(`/api/library/documents/${documentId}`, { jar });
  assert.equal(data.ok, true, JSON.stringify(data));
  return data;
};
const patch = async (documentId, body) =>
  (await api(`/api/library/documents/${documentId}`, { method: 'PATCH', body, jar })).data;

describe('phase 14 — a document in full', () => {
  before(async () => {
    await startServer({ env: { LEGAL_FAKE_GRAPH: '' } });
    jar = await loginAdmin();
    await insertDoc('doc_pol', 'Politica de Compras.pdf');
    await insertDoc('doc_reg', 'Regulamento de Compras.pdf');
  });
  after(async () => {
    await stopServer();
  });

  it('carries §8’s whole field list, and says which fields are the user’s', async () => {
    const before = await detail('doc_pol');
    assert.deepEqual(before.document.correctedFields, []);
    for (const key of ['expiryDate', 'approvalStatus', 'legislation', 'obligations', 'deadlines']) {
      assert.ok(key in before.document, `§8 field ${key} is missing from the payload`);
    }

    const written = {
      title: 'Política de Compras',
      docType: 'policy',
      subject: 'Aquisição de bens e serviços',
      topics: ['compras'],
      subtopics: ['fornecedores', 'adjudicação'],
      entity: 'Grupo Barraqueiro',
      groupArea: 'Financeira',
      issuedDate: '2026-01-15',
      effectiveDate: '2026-02-01',
      expiryDate: '2027-02-01',
      versionLabel: 'v3',
      approvalStatus: 'aprovado',
      language: 'pt-PT',
      legislation: ['Decreto-Lei 18/2008'],
      obligations: ['Três propostas por adjudicação'],
      deadlines: ['30 de abril'],
    };
    const saved = await patch('doc_pol', written);
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.deepEqual(saved.corrected.sort(), Object.keys(written).sort());

    const after = await detail('doc_pol');
    assert.equal(after.document.title, 'Política de Compras');
    assert.equal(after.document.approvalStatus, 'aprovado');
    assert.equal(after.document.expiryDate, '2027-02-01');
    assert.deepEqual(after.document.subtopics, ['fornecedores', 'adjudicação']);
    assert.deepEqual(after.document.legislation, ['Decreto-Lei 18/2008']);
    assert.deepEqual(after.document.correctedFields.sort(), Object.keys(written).sort());
  });

  it('refuses a value outside a field’s vocabulary rather than storing it', async () => {
    await patch('doc_reg', { docType: 'nao_existe', approvalStatus: 'talvez', title: 'Regulamento' });
    const { document } = await detail('doc_reg');
    assert.equal(document.docType, '');
    assert.equal(document.approvalStatus, '');
    // The legal field in the same request still lands: one bad value is not a failed save.
    assert.equal(document.title, 'Regulamento');
    assert.deepEqual(document.correctedFields, ['title']);
  });

  it('a re-classification leaves the user’s answers alone and refreshes the rest', async () => {
    process.env.LEGAL_DATA_DIR = testDataDir();
    const { applyClassifierMetadata } = await loadTsModule('src/lib/server/repo/document-metadata.ts');

    const written = applyClassifierMetadata('doc_pol', {
      // Fields the user corrected — every one of these must be ignored.
      title: 'TÍTULO DA AI',
      document_type: 'contract',
      issued_date: '1999-01-01',
      approval_status: 'rascunho',
      subtopics: ['inventado'],
      obligations: ['inventada'],
      // Fields nobody touched — these must land.
      references: [{ text: 'Decreto-Lei 18/2008', citation: { document_id: 'doc_pol', page: 2, excerpt: 'DL 18/2008' } }],
    });

    const { document } = await detail('doc_pol');
    assert.equal(document.title, 'Política de Compras', 'a corrected title must survive re-ingest');
    assert.equal(document.docType, 'policy');
    assert.equal(document.issuedDate, '2026-01-15');
    assert.equal(document.approvalStatus, 'aprovado');
    assert.deepEqual(document.subtopics, ['fornecedores', 'adjudicação']);
    assert.deepEqual(document.obligations, ['Três propostas por adjudicação']);
    assert.ok(!written.includes('title'), 'the writer must report that it skipped the corrected fields');
    // …and it really did write what it was allowed to, so this is not passing by doing nothing.
    assert.equal(document.references.length, 1);
    assert.ok(document.classifiedAt > 0);
  });

  it('resetting a field hands it back to the AI, and the next classification fills it', async () => {
    const reset = await patch('doc_pol', { reset: ['title'] });
    assert.deepEqual(reset.cleared, ['title']);
    assert.ok(!reset.document.correctedFields.includes('title'));
    // The value itself is untouched until something recomputes it — the UI says as much.
    assert.equal(reset.document.title, 'Política de Compras');

    process.env.LEGAL_DATA_DIR = testDataDir();
    const { applyClassifierMetadata } = await loadTsModule('src/lib/server/repo/document-metadata.ts');
    applyClassifierMetadata('doc_pol', { title: 'Sugestão da AI', references: [] });
    const { document } = await detail('doc_pol');
    assert.equal(document.title, 'Sugestão da AI');
    assert.equal(document.entity, 'Grupo Barraqueiro', 'a field still corrected stays corrected');
  });

  it('an edge is shown from both ends, and the inbound one is not flipped into its inverse', async () => {
    const added = await api('/api/library/documents/doc_reg/relations', {
      method: 'POST',
      body: { toDocumentId: 'doc_pol', type: 'altera' },
      jar,
    });
    assert.equal(added.status, 200, JSON.stringify(added.data));

    // The relation is the PAIR; the direction and the type belong to the reason under it.
    const from = await detail('doc_reg');
    const outbound = from.relations.find((r) => r.otherDocumentId === 'doc_pol');
    assert.equal(outbound.motives.length, 1);
    assert.equal(outbound.motives[0].direction, 'outbound');
    assert.equal(outbound.motives[0].type, 'altera');

    const to = await detail('doc_pol');
    const inbound = to.relations.find((r) => r.otherDocumentId === 'doc_reg');
    assert.equal(inbound.motives[0].direction, 'inbound');
    assert.equal(inbound.otherDocumentName, 'Regulamento de Compras.pdf');
    // NOT 'e_alterado_por': flipping would assert a second edge nobody judged, and the
    // inverse does not carry the exact evidence the original was accepted on (§9).
    assert.equal(inbound.motives[0].type, 'altera');
    assert.equal(inbound.motives[0].relationId, outbound.motives[0].relationId);
  });

  it('lists the analyses a document took part in, and how it took part', async () => {
    const created = await api('/api/analyses', {
      method: 'POST',
      body: { type: 'summary', mainDocumentId: 'doc_pol', relatedDocumentIds: ['doc_reg'] },
      jar,
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const analysisId = created.data.analysis.analysisId;

    const main = await detail('doc_pol');
    const asMain = main.analyses.find((a) => a.analysisId === analysisId);
    assert.equal(asMain.role, 'main');
    assert.equal(asMain.type, 'summary');

    const related = await detail('doc_reg');
    assert.equal(related.analyses.find((a) => a.analysisId === analysisId).role, 'related');

    // Neither document is one of the app's own outputs, so neither claims to be generated.
    assert.equal(main.generatedBy, null);
  });
});
