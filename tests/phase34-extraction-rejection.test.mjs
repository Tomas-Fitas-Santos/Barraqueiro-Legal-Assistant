import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, loginAdmin, seedExtraction, startServer, stopServer, testDataDir } from './helpers.mjs';

async function db() {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
}

let jar;
let analysisId;
let extractionId;

describe('phase 34 — rejecting a complete extraction is an auditable retry', () => {
  before(async () => {
    await startServer();
    jar = await loginAdmin();
    const d = await db();
    const now = Date.now();
    d.prepare(
      `INSERT INTO documents
         (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
       VALUES ('doc_retry', 'drive_retry', 'Regulamento.pdf', '1. Documentos oficiais/Regulamento.pdf',
               'application/pdf', 100, 'indexed', 0, ?, ?, ?)`,
    ).run(now, now, now);
    d.close();

    const created = await api('/api/analyses', {
      method: 'POST',
      body: { type: 'summary', mainDocumentId: 'doc_retry' },
      jar,
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    analysisId = created.data.analysis.analysisId;

    const d2 = await db();
    d2.prepare(`UPDATE analyses SET state = 'pronta_para_revisao' WHERE analysis_id = ?`).run(analysisId);
    extractionId = seedExtraction(d2, analysisId, 'ext_retry');
    d2.prepare(
      `INSERT INTO analysis_items
         (item_id, analysis_id, extraction_id, seq, kind, payload_json, accepted, created_at)
       VALUES ('itm_retry', ?, ?, 0, 'statement', ?, 1, ?)`,
    ).run(analysisId, extractionId, JSON.stringify({
      statement_type: 'obligation', content: 'Conservar o registo.',
      source_document_id: 'doc_retry', source_page: 1, source_excerpt: 'Conservar o registo.',
      evidence_quality: 'direct', requires_legal_decision: false,
    }), now);
    d2.prepare('UPDATE analysis_extractions SET accepted_count = 1 WHERE extraction_id = ?').run(extractionId);
    d2.close();
  });

  after(async () => stopServer());

  it('requires an explanation and preserves the rejected artifact', async () => {
    const missing = await api(`/api/analyses/${analysisId}/extraction/reject`, {
      method: 'POST', body: { reason: '   ' }, jar,
    });
    assert.equal(missing.status, 400);

    const rejected = await api(`/api/analyses/${analysisId}/extraction/reject`, {
      method: 'POST', body: { reason: 'A fonte citada não sustenta a conclusão; rever o âmbito.' }, jar,
    });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
    assert.equal(rejected.data.restart, 'run');

    const d = await db();
    const extraction = d.prepare(
      'SELECT rejected_at, rejected_by, rejection_reason FROM analysis_extractions WHERE extraction_id = ?',
    ).get(extractionId);
    assert.ok(extraction.rejected_at > 0);
    assert.match(extraction.rejected_by, /@/);
    assert.match(extraction.rejection_reason, /fonte citada/);
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM analysis_items WHERE extraction_id = ?').get(extractionId).n, 1);

    const analysis = d.prepare('SELECT state FROM analyses WHERE analysis_id = ?').get(analysisId);
    assert.equal(analysis.state, 'rascunho');
    const events = d.prepare(
      `SELECT kind FROM analysis_events WHERE analysis_id = ? AND kind IN ('extraction_rejected','tracked_back') ORDER BY created_at`,
    ).all(analysisId).map((row) => row.kind);
    assert.deepEqual(new Set(events), new Set(['extraction_rejected', 'tracked_back']));
    d.close();
  });
});
