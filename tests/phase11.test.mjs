import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loginAdmin, startServer, stopServer, testDataDir, seedExtraction } from './helpers.mjs';

// Phase 11 — the extraction as an approvable artifact.
//
// The structured output of a run is immutable and versioned, like a document version. It
// is approved as a WHOLE, that approval is recorded on the artifact rather than inferred
// from the analysis state, and a hand edit produces a new extraction instead of mutating
// the one a decision may already have been taken on.

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

async function db() {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
}

let analysisId = '';
let jar;

describe('phase 11 — the extraction is an artifact (no model calls)', () => {
  before(async () => {
    await startServer();
    jar = await loginAdmin();
    const bytes = readFileSync(path.join(FIXTURES, 'nota-interna-transparencia-salarial.pdf'));
    const d0 = await db();
    const now = Date.now();
    d0.prepare(
      `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
       VALUES ('doc_x11', 'local-doc_x11', 'Nota Interna.pdf', '', 'application/pdf', 0, 'listed', 0, ?, ?, ?)`,
    ).run(now, now, now);
    d0.close();
    await fetch(`${BASE}/api/library/documents/doc_x11/original`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: bytes,
    });
    const created = await api('/api/analyses', {
      method: 'POST',
      body: { type: 'summary', mainDocumentId: 'doc_x11' },
      jar,
    });
    analysisId = created.data.analysis.analysisId;

    const d = await db();
    d.prepare(`UPDATE analyses SET state = 'pronta_para_revisao' WHERE analysis_id = ?`).run(analysisId);
    const extractionId = seedExtraction(d, analysisId, `ext_${analysisId.slice(-8)}`);
    const insert = d.prepare(
      `INSERT INTO analysis_items (item_id, analysis_id, extraction_id, seq, kind, payload_json, accepted, created_at)
       VALUES (?, ?, ?, ?, 'statement', ?, ?, ?)`,
    );
    // One valid statement, and one the validators rejected — both belong to the artifact,
    // because the rejection and its reason are part of what the user reviews.
    insert.run(`itm_x11_0`, analysisId, extractionId, 0, JSON.stringify({
      topic: 'Transparência salarial',
      scope: 'Todas as empresas do Grupo',
      statement_type: 'obligation',
      content: 'Garantir a igualdade salarial.',
      entity: 'Colaboradores', required_action: 'Garantir', suggested_owner: '', deadline: '',
      consequence: '', exceptions: '',
      source_document_id: 'doc_x11', source_version: '', source_page: 1,
      source_excerpt: 'igualdade', evidence_quality: 'direct', ai_suggestion: false,
    }), 1, Date.now());
    insert.run(`itm_x11_1`, analysisId, extractionId, 1, JSON.stringify({
      topic: '', scope: '', statement_type: 'obligation', content: 'Obrigação sem fonte.',
      entity: '', required_action: '', suggested_owner: '', deadline: '', consequence: '', exceptions: '',
      source_document_id: '', source_version: '', source_page: 0, source_excerpt: '',
      evidence_quality: 'direct', ai_suggestion: false,
    }), 0, Date.now());
    d.prepare(
      `UPDATE analysis_extractions SET accepted_count = 1, rejected_count = 1 WHERE extraction_id = ?`,
    ).run(extractionId);
    d.close();
  });

  after(async () => {
    await stopServer();
  });

  it('serves the extraction rendered: items, their rejection reasons, and the cited sources', async () => {
    const res = await api(`/api/analyses/${analysisId}/extraction`, { jar });
    assert.equal(res.data.ok, true);
    assert.equal(res.data.extraction.acceptedCount, 1);
    assert.equal(res.data.extraction.rejectedCount, 1);
    assert.equal(res.data.extraction.approvedAt, null, 'a fresh extraction is not approved');
    assert.equal(res.data.items.length, 2, 'rejected items are part of the artifact, not hidden');

    // The §10 fields the briefing asks for are carried through, including the two the
    // schema was missing (tema, âmbito de aplicação).
    const accepted = res.data.items.find((i) => i.accepted);
    assert.equal(accepted.payload.topic, 'Transparência salarial');
    assert.equal(accepted.payload.scope, 'Todas as empresas do Grupo');
    assert.equal(accepted.payload.evidence_quality, 'direct');

    // Every cited document is resolvable, so the review surface can open it.
    assert.ok(res.data.sources.some((s) => s.documentId === 'doc_x11'));
  });

  it('the phase is Revisão until the extraction is approved, then Documento', async () => {
    const before = await api(`/api/analyses/${analysisId}/timeline`, { jar });
    assert.equal(before.data.workflow.phase.key, 'revisao');
    assert.equal(before.data.workflow.actions[0].id, 'approve_extraction');
    assert.equal(before.data.workflow.actions[0].enabled, true);

    const approved = await api(`/api/analyses/${analysisId}/approve`, { method: 'POST', jar });
    assert.equal(approved.data.ok, true);

    // Approval is recorded on the ARTIFACT, not merely on the analysis.
    const extraction = await api(`/api/analyses/${analysisId}/extraction`, { jar });
    assert.ok(extraction.data.extraction.approvedAt, 'the extraction carries its own approval');
    assert.match(extraction.data.extraction.approvedBy, /@/);

    const after = await api(`/api/analyses/${analysisId}/timeline`, { jar });
    assert.equal(after.data.workflow.phase.key, 'documento');
    // Approving hands off to the agent: the document is written without a second click.
    assert.ok(
      after.data.feed.some((e) => e.kind === 'version'),
      'approving the extraction generates the document',
    );
  });

  it('a hand edit creates a NEW extraction and leaves the approved one intact', async () => {
    const current = await api(`/api/analyses/${analysisId}/extraction`, { jar });
    const original = current.data.extraction;
    const items = current.data.items.map((i) => i.payload);
    items[0] = { ...items[0], content: 'Garantir a igualdade salarial em todas as empresas.' };

    // §13: rewriting content that rests on a cited excerpt is one of the six operations
    // that need an explicit confirmation. The app decides that by diffing the artifact.
    const gated = await api(`/api/analyses/${analysisId}/extraction`, { method: 'PUT', body: { items }, jar });
    assert.equal(gated.data.needsConfirmation, true);
    assert.ok(gated.data.reasons.some((r) => /suportado por uma fonte/.test(r)));

    const saved = await api(`/api/analyses/${analysisId}/extraction`, {
      method: 'PUT',
      body: { items, confirmed: true },
      jar,
    });
    assert.equal(saved.data.ok, true);
    assert.notEqual(saved.data.extraction.extractionId, original.extractionId);
    assert.equal(saved.data.extraction.origin, 'manual');
    assert.equal(saved.data.extraction.approvedAt, null, 'an edit is not approved by inheritance');

    // The edited text is there, and the previous artifact still says what it said.
    const edited = saved.data.items.find((i) => i.accepted);
    assert.match(edited.payload.content, /em todas as empresas/);

    const d = await db();
    const before = d
      .prepare('SELECT payload_json FROM analysis_items WHERE extraction_id = ? AND seq = 0')
      .get(original.extractionId);
    d.close();
    assert.equal(JSON.parse(before.payload_json).content, 'Garantir a igualdade salarial.');
  });

  it('an edit is re-validated: a citation the app cannot verify is rejected on the way in', async () => {
    const current = await api(`/api/analyses/${analysisId}/extraction`, { jar });
    const items = current.data.items.map((i) => i.payload);
    // Point the accepted statement at a page that does not exist.
    items[0] = { ...items[0], source_page: 9999 };

    const saved = await api(`/api/analyses/${analysisId}/extraction`, {
      method: 'PUT',
      body: { items, confirmed: true },
      jar,
    });
    assert.equal(saved.data.ok, true);
    const item = saved.data.items[0];
    assert.equal(item.accepted, false, '§11 runs on hand edits too');
    assert.match(item.rejectionReason, /Página citada/);
  });

  it('§13: the six operations that need an explicit confirmation are named, not just flagged', async () => {
    const current = await api(`/api/analyses/${analysisId}/extraction`, { jar });
    const items = current.data.items.map((i) => i.payload);

    // Delete the source a statement rests on.
    const noSource = items.map((i, n) => (n === 0 ? { ...i, source_document_id: '', source_page: 0 } : i));
    const a = await api(`/api/analyses/${analysisId}/extraction`, { method: 'PUT', body: { items: noSource }, jar });
    assert.equal(a.data.needsConfirmation, true);
    assert.ok(a.data.reasons.some((r) => /Elimina a fonte/.test(r)), JSON.stringify(a.data.reasons));

    // Turn a documented fact into a recommendation.
    const asSuggestion = items.map((i, n) => (n === 0 ? { ...i, ai_suggestion: true } : i));
    const b = await api(`/api/analyses/${analysisId}/extraction`, { method: 'PUT', body: { items: asSuggestion }, jar });
    assert.equal(b.data.needsConfirmation, true);
    assert.ok(b.data.reasons.some((r) => /numa recomendação/.test(r)));

    // Drop items entirely.
    const c = await api(`/api/analyses/${analysisId}/extraction`, {
      method: 'PUT',
      body: { items: items.slice(0, 1) },
      jar,
    });
    assert.equal(c.data.needsConfirmation, true);
    assert.ok(c.data.reasons.some((r) => /Remove \d+ item/.test(r)));

    // An edit that touches nothing sourced passes without a gate.
    const harmless = items.map((i, n) => (n === 0 ? { ...i, suggested_owner: 'Compliance' } : i));
    const d = await api(`/api/analyses/${analysisId}/extraction`, {
      method: 'PUT',
      body: { items: harmless },
      jar,
    });
    assert.equal(d.data.ok, true, JSON.stringify(d.data));
  });

  it('reverting past the approval means the new path must review it again', async () => {
    // Revert to Revisão: the new path inherits the extraction, but not the approval the
    // path it branched from had given it.
    const reverted = await api(`/api/analyses/${analysisId}/track-back`, {
      method: 'POST',
      body: { stage: 'revisao', guidance: 'Rever os itens com outro critério.' },
      jar,
    });
    assert.equal(reverted.data.ok, true, JSON.stringify(reverted.data));

    const after = await api(`/api/analyses/${analysisId}/timeline`, { jar });
    assert.notEqual(after.data.activePath, 'a', 'the revert created a new path');
    assert.equal(after.data.workflow.phase.key, 'revisao', 'and it is back at the review');
    assert.equal(after.data.workflow.actions[0].id, 'approve_extraction');
  });

  it('refuses an empty extraction', async () => {
    const res = await api(`/api/analyses/${analysisId}/extraction`, { method: 'PUT', body: { items: [] }, jar });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /não pode ficar vazia/);
  });
});
