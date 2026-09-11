import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loadTsModule, loginAdmin, startServer, stopServer, testDataDir, seedExtraction } from './helpers.mjs';

// Phase 4 — analyses: the state machine and its gates driven through the real API (the
// run stage itself needs the model and is live-checked separately), plus the §11
// validators — including the poisoned-run cases — as unit tests over the shipped leaf.

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

async function db() {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
}

async function insertDocRow(documentId, name) {
  const d = await db();
  const now = Date.now();
  d.prepare(
    `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
     VALUES (?, ?, ?, '', 'application/pdf', 0, 'listed', 0, ?, ?, ?)`,
  ).run(documentId, `local-${documentId}`, name, now, now, now);
  d.close();
}

async function uploadFixture(jar, documentId, fixtureName) {
  const bytes = readFileSync(path.join(FIXTURES, fixtureName));
  const res = await fetch(`${BASE}/api/library/documents/${documentId}/original`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    },
    body: bytes,
  });
  return { status: res.status, data: await res.json() };
}

describe('phase 4 — analyses (no model calls)', () => {
  before(async () => {
    await startServer();
    const jar = await loginAdmin();
    await insertDocRow('doc_main', 'Documento Principal.pdf');
    await uploadFixture(jar, 'doc_main', 'nota-interna-transparencia-salarial.pdf');
    await insertDocRow('doc_rel', 'Documento Relacionado.pdf');
    await uploadFixture(jar, 'doc_rel', 'nota-interna-transparencia-salarial.pdf');
    // A classification reference main -> related so the relations engine finds it.
    const d = await db();
    d.prepare(`UPDATE documents SET title = 'Documento Principal', references_json = ? WHERE document_id = 'doc_main'`).run(
      JSON.stringify([
        { text: 'Documento Relacionado', citation: { document_id: 'doc_main', page: 1, excerpt: 'x' } },
      ]),
    );
    d.prepare(`UPDATE documents SET title = 'Documento Relacionado' WHERE document_id = 'doc_rel'`).run();
    d.close();
  });
  after(async () => {
    await stopServer();
  });

  it('gates all analysis APIs on the session', async () => {
    for (const [method, p] of [
      ['GET', '/api/analyses'],
      ['POST', '/api/analyses'],
      ['GET', '/api/analyses/ana_x'],
      ['POST', '/api/analyses/ana_x/run'],
      ['POST', '/api/analyses/ana_x/approve'],
    ]) {
      const res = await api(p, { method });
      assert.equal(res.status, 401, `${method} ${p}`);
    }
  });

  it('summary: created as rascunho with the main doc confirmed; run refused without AI', async () => {
    const jar = await loginAdmin();
    const created = await api('/api/analyses', {
      method: 'POST',
      body: { type: 'summary', mainDocumentId: 'doc_main' },
      jar,
    });
    assert.equal(created.data.ok, true);
    assert.equal(created.data.analysis.state, 'rascunho');

    const id = created.data.analysis.analysisId;
    const detail = await api(`/api/analyses/${id}`, { jar });
    assert.equal(detail.data.documents.length, 1);
    assert.equal(detail.data.documents[0].role, 'main');
    assert.equal(detail.data.documents[0].status, 'confirmed');
    assert.equal(detail.data.events[0].kind, 'created');

    const run = await api(`/api/analyses/${id}/run`, { method: 'POST', jar });
    assert.equal(run.status, 400);
    assert.match(run.data.error, /liga(ç|c)ão à IA/);
    // Refusal leaves the state untouched and is on the record.
    const after = await api(`/api/analyses/${id}`, { jar });
    assert.equal(after.data.analysis.state, 'rascunho');
    assert.ok(after.data.events.some((e) => e.kind === 'run_refused'));
  });

  it('revision: identify-relations builds the pending set; run gated on every decision', async () => {
    const jar = await loginAdmin();
    const created = await api('/api/analyses', {
      method: 'POST',
      body: { type: 'revision', mainDocumentId: 'doc_main' },
      jar,
    });
    const id = created.data.analysis.analysisId;

    // Run before identifying relations: wrong state.
    const early = await api(`/api/analyses/${id}/run`, { method: 'POST', jar });
    assert.equal(early.status, 409);

    const identified = await api(`/api/analyses/${id}/identify-relations`, { method: 'POST', jar });
    assert.equal(identified.data.ok, true, JSON.stringify(identified.data));
    assert.equal(identified.data.analysis.state, 'a_aguardar_confirmacao_de_documentos');
    const related = identified.data.documents.filter((d) => d.role === 'related');
    assert.ok(related.length >= 1, 'the engine must fold the doc_rel proposal into the set');
    assert.ok(related.every((d) => d.status === 'pending'));

    // Run refused while any related document is undecided (the confirmation gate).
    const gated = await api(`/api/analyses/${id}/run`, { method: 'POST', jar });
    assert.equal(gated.status, 409);
    assert.match(gated.data.error, /por decidir/);

    // Excluding every candidate: a revision with no confirmed related docs cannot run.
    for (const doc of related) {
      const decided = await api(`/api/analyses/${id}/documents/${doc.documentId}`, {
        method: 'PATCH',
        body: { status: 'excluded' },
        jar,
      });
      assert.equal(decided.data.ok, true);
    }
    const noDocs = await api(`/api/analyses/${id}/run`, { method: 'POST', jar });
    assert.equal(noDocs.status, 409);
    assert.match(noDocs.data.error, /pelo menos um documento relacionado confirmado/);

    // Confirm one → the only remaining refusal is the AI itself (the harness has none).
    const confirm = await api(`/api/analyses/${id}/documents/${related[0].documentId}`, {
      method: 'PATCH',
      body: { status: 'confirmed' },
      jar,
    });
    assert.equal(confirm.data.ok, true);
    const aiRefused = await api(`/api/analyses/${id}/run`, { method: 'POST', jar });
    assert.equal(aiRefused.status, 400);
    assert.match(aiRefused.data.error, /liga(ç|c)ão à IA/);

    // The trail recorded every decision (§5.5).
    const detail = await api(`/api/analyses/${id}`, { jar });
    const kinds = detail.data.events.map((e) => e.kind);
    assert.ok(kinds.includes('relations_identified'));
    assert.ok(kinds.includes('document_excluded'));
    assert.ok(kinds.includes('document_confirmed'));
  });

  it('matrix review: requires_legal_decision blocks approval until decided', async () => {
    const jar = await loginAdmin();
    const created = await api('/api/analyses', {
      method: 'POST',
      body: { type: 'revision', mainDocumentId: 'doc_rel' },
      jar,
    });
    const id = created.data.analysis.analysisId;

    // Simulate a completed run: state + two validated matrix lines, one legal-decision.
    const d = await db();
    d.prepare(`UPDATE analyses SET state = 'pronta_para_revisao' WHERE analysis_id = ?`).run(id);
    seedExtraction(d, id, `ext_${id.slice(-6)}`);
    const now = Date.now();
    const line = (seq, requires) =>
      d.prepare(
        `INSERT INTO analysis_items (item_id, analysis_id, extraction_id, seq, kind, payload_json, accepted, created_at)
         VALUES (?, ?, ?, ?, 'matrix_line', ?, 1, ?)`,
      ).run(`itm_t${seq}_${id.slice(-4)}`, id, `ext_${id.slice(-6)}`, seq, JSON.stringify({
        topic: `Tópico ${seq}`,
        current_content: 'x', current_page: 1, related_content: 'y',
        relationship_type: 'complementa', difference: 'd', proposed_change: 'p', impact: 'i',
        requires_legal_decision: requires,
        source_document_id: 'doc_main', source_version: '', source_page: 1, source_excerpt: 'x',
        evidence_quality: 'direct', ai_suggestion: false,
      }), now);
    line(0, true);
    line(1, false);
    d.close();

    const blocked = await api(`/api/analyses/${id}/approve`, { method: 'POST', jar });
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.error, /decisão jurídica/);

    const detail = await api(`/api/analyses/${id}`, { jar });
    const legalLine = detail.data.items.find((i) => i.payload.requires_legal_decision === true);
    const decided = await api(`/api/analyses/${id}/items/${legalLine.itemId}`, {
      method: 'PATCH',
      body: { decision: 'accepted' },
      jar,
    });
    assert.equal(decided.data.ok, true);

    const approved = await api(`/api/analyses/${id}/approve`, { method: 'POST', jar });
    assert.equal(approved.data.ok, true);
    assert.equal(approved.data.analysis.state, 'aprovada');

    // Approved is terminal for decisions and repeat approvals.
    const again = await api(`/api/analyses/${id}/approve`, { method: 'POST', jar });
    assert.equal(again.status, 409);
  });

  it('changed content on a confirmed document flags the approved analysis (§15)', async () => {
    const jar = await loginAdmin();
    // The analysis approved above has doc_main confirmed? No — doc_rel main + doc_main cited
    // in items; the confirmed SET is what counts. Add doc_main as confirmed to that set.
    const list = await api('/api/analyses', { jar });
    const approved = list.data.analyses.find((a) => a.state === 'aprovada');
    assert.ok(approved);
    const d = await db();
    d.prepare(
      `INSERT INTO analysis_documents (analysis_id, document_id, role, status, decided_at)
       VALUES (?, 'doc_main', 'related', 'confirmed', ?) ON CONFLICT(analysis_id, document_id) DO NOTHING`,
    ).run(approved.analysisId, Date.now());
    d.close();

    // New bytes for doc_main → content change → flag, never regenerate.
    const changed = await uploadFixture(jar, 'doc_main', 'codigo-conduta.pdf');
    assert.equal(changed.status, 200);

    const after = await api(`/api/analyses/${approved.analysisId}`, { jar });
    assert.equal(after.data.analysis.potentiallyAffected, true);
    assert.match(after.data.analysis.affectedReason, /alterado no OneDrive/);
    assert.equal(after.data.analysis.state, 'aprovada'); // state untouched — flag only
    assert.ok(after.data.events.some((e) => e.kind === 'potentially_affected'));

    // The warning reaches the user as a notice with a way to act on it: it used to be a
    // permanent flag with no action, so once raised it stayed on the analysis forever.
    const timeline = await api(`/api/analyses/${approved.analysisId}/timeline`, { jar });
    const notice = timeline.data.workflow.notices.find((n) => n.id === 'potentially_affected');
    assert.ok(notice, 'the flag surfaces as a notice');
    assert.ok(notice.dismissPath, 'and the notice can be decided about');

    const dismissed = await api(`/api/analyses/${approved.analysisId}/affected`, { method: 'DELETE', jar });
    assert.equal(dismissed.data.ok, true);
    const cleared = await api(`/api/analyses/${approved.analysisId}`, { jar });
    assert.equal(cleared.data.analysis.potentiallyAffected, false);
    assert.ok(cleared.data.events.some((e) => e.kind === 'affected_dismissed'), 'the decision is recorded');
  });

  it('eliminada hides the analysis and 404s its detail', async () => {
    const jar = await loginAdmin();
    const created = await api('/api/analyses', {
      method: 'POST',
      body: { type: 'summary', mainDocumentId: 'doc_rel' },
      jar,
    });
    const id = created.data.analysis.analysisId;
    const deleted = await api(`/api/analyses/${id}`, { method: 'DELETE', jar });
    assert.equal(deleted.data.ok, true);
    const detail = await api(`/api/analyses/${id}`, { jar });
    assert.equal(detail.status, 404);
    const list = await api('/api/analyses', { jar });
    assert.ok(!list.data.analyses.some((a) => a.analysisId === id));
  });

  it('§11 validators: the poisoned-run cases, over the shipped leaf module', async () => {
    const { validateAnalysisItem } = await loadTsModule('src/lib/server/analysis-rules.ts');

    const base = {
      statement_type: 'obligation',
      content: 'Obrigação X',
      source_document_id: 'doc_main',
      source_page: 3,
      source_excerpt: 'texto real',
      evidence_quality: 'direct',
      ai_suggestion: false,
    };
    const okCtx = { sourceExists: true, sourceConfirmed: true, pageExists: true, excerptOnPage: true };

    assert.equal(validateAnalysisItem(base, okCtx).accepted, true);

    // Poisoned: invented source document.
    const invented = validateAnalysisItem({ ...base, source_document_id: 'doc_fake' }, { ...okCtx, sourceExists: false, sourceConfirmed: false });
    assert.equal(invented.accepted, false);
    assert.match(invented.reason, /inventada/);

    // Poisoned: source outside the confirmed set.
    const unconfirmed = validateAnalysisItem(base, { ...okCtx, sourceConfirmed: false });
    assert.equal(unconfirmed.accepted, false);
    assert.match(unconfirmed.reason, /confirmado/);

    // Poisoned: fabricated page.
    const badPage = validateAnalysisItem({ ...base, source_page: 999 }, { ...okCtx, pageExists: false });
    assert.equal(badPage.accepted, false);
    assert.match(badPage.reason, /Página/);

    // Poisoned: excerpt not on the page.
    const badExcerpt = validateAnalysisItem(base, { ...okCtx, excerptOnPage: false });
    assert.equal(badExcerpt.accepted, false);
    assert.match(badExcerpt.reason, /Excerto/);

    // Obligation without any source: rejected outright.
    const noSource = validateAnalysisItem(
      { ...base, source_document_id: '', source_page: 0, source_excerpt: '' },
      { sourceExists: false, sourceConfirmed: false, pageExists: false, excerptOnPage: false },
    );
    assert.equal(noSource.accepted, false);
    assert.match(noSource.reason, /sem fonte/);

    // A marked AI suggestion without citation passes; with a FAKE citation it does not.
    const suggestion = validateAnalysisItem(
      { ...base, statement_type: 'recommendation', ai_suggestion: true, source_document_id: '', source_page: 0, source_excerpt: '' },
      { sourceExists: false, sourceConfirmed: false, pageExists: false, excerptOnPage: false },
    );
    assert.equal(suggestion.accepted, true);
    const fakeCited = validateAnalysisItem(
      { ...base, ai_suggestion: true },
      { ...okCtx, excerptOnPage: false },
    );
    assert.equal(fakeCited.accepted, false);

    // Unsourced non-obligation must be honestly not_confirmed.
    const dishonest = validateAnalysisItem(
      { ...base, statement_type: 'other', deadline: '', source_document_id: '', source_page: 0, source_excerpt: '' },
      { sourceExists: false, sourceConfirmed: false, pageExists: false, excerptOnPage: false },
    );
    assert.equal(dishonest.accepted, false);
    const honest = validateAnalysisItem(
      { ...base, statement_type: 'other', deadline: '', evidence_quality: 'not_confirmed', source_document_id: '', source_page: 0, source_excerpt: '' },
      { sourceExists: false, sourceConfirmed: false, pageExists: false, excerptOnPage: false },
    );
    assert.equal(honest.accepted, true);
  });
});
