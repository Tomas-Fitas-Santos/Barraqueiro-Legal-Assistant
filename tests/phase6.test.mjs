import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loadTsModule, loginAdmin, startServer, stopServer, testDataDir, seedExtraction } from './helpers.mjs';

// Phase 6 — the revision chat, without any model call: the §13 gate mechanics (pending →
// confirm creates a version / discard leaves none), the state interplay, and the
// deterministic cross-check — including the under-reporting-model case — as unit tests
// over the shipped leaf module.

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

async function db() {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
}

let analysisId = '';

describe('phase 6 — revision chat (no model calls)', () => {
  before(async () => {
    await startServer();
    const jar = await loginAdmin();
    const bytes = readFileSync(path.join(FIXTURES, 'nota-interna-transparencia-salarial.pdf'));
    const d0 = await db();
    const now = Date.now();
    d0.prepare(
      `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
       VALUES ('doc_main', 'local-doc_main', 'Nota Interna.pdf', '', 'application/pdf', 0, 'listed', 0, ?, ?, ?)`,
    ).run(now, now, now);
    d0.close();
    await fetch(`${BASE}/api/library/documents/doc_main/original`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: bytes,
    });
    const created = await api('/api/analyses', {
      method: 'POST',
      body: { type: 'summary', mainDocumentId: 'doc_main' },
      jar,
    });
    analysisId = created.data.analysis.analysisId;
    const d = await db();
    d.prepare(`UPDATE analyses SET state = 'pronta_para_revisao' WHERE analysis_id = ?`).run(analysisId);
    const extractionId = seedExtraction(d, analysisId, `ext_${analysisId.slice(-8)}`);
    d.prepare(
      `INSERT INTO analysis_items (item_id, analysis_id, extraction_id, seq, kind, payload_json, accepted, created_at)
       VALUES ('itm_p6_0', ?, ?, 0, 'statement', ?, 1, ?)`,
    ).run(analysisId, extractionId, JSON.stringify({
      statement_type: 'obligation',
      content: 'Garantir a igualdade salarial.',
      source_document_id: 'doc_main', source_version: '', source_page: 1,
      source_excerpt: 'trabalho igual salário igual', evidence_quality: 'direct', ai_suggestion: false,
    }), now);
    d.close();
    // A generated (sectioned) version for the chat to act on — fallback narrative path.
    const generated = await api(`/api/analyses/${analysisId}/versions`, { method: 'POST', jar });
    assert.equal(generated.data.ok, true, JSON.stringify(generated.data));
  });
  after(async () => {
    await stopServer();
  });

  it('chat refuses without AI, with a pending change, and in wrong states', async () => {
    const jar = await loginAdmin();
    // AI unconfigured in the harness → clear refusal (the state/version guards passed).
    const noAi = await api(`/api/analyses/${analysisId}/chat`, { method: 'POST', body: { message: 'Simplifica.' }, jar });
    assert.equal(noAi.status, 400);
    assert.match(noAi.data.error, /liga(ç|c)ão à IA/);

    // 'aprovada' is an OPEN state for the chat (a confirmed change reopens review), so the
    // only refusal there is the missing AI — not the state.
    const d = await db();
    d.prepare(`UPDATE analyses SET state = 'aprovada' WHERE analysis_id = ?`).run(analysisId);
    d.close();
    const approvedState = await api(`/api/analyses/${analysisId}/chat`, { method: 'POST', body: { message: 'x' }, jar });
    assert.equal(approvedState.status, 400);
    assert.match(approvedState.data.error, /liga(ç|c)ão à IA/);

    // A closed state (em_processamento) IS refused on state.
    const d2 = await db();
    d2.prepare(`UPDATE analyses SET state = 'em_processamento' WHERE analysis_id = ?`).run(analysisId);
    d2.close();
    const wrongState = await api(`/api/analyses/${analysisId}/chat`, { method: 'POST', body: { message: 'x' }, jar });
    assert.equal(wrongState.status, 409);
    const d3 = await db();
    d3.prepare(`UPDATE analyses SET state = 'pronta_para_revisao' WHERE analysis_id = ?`).run(analysisId);
    d3.close();
  });

  it('a gated pending change: confirm applies as a NEW version; the trail records it', async () => {
    const jar = await loginAdmin();
    const before1 = await api(`/api/analyses/${analysisId}/versions`, { jar });
    const versionCountBefore = before1.data.versions.length;

    // Seed the pending turn exactly as sendChatMessage parks it (the model step is the
    // only part skipped — its output shape is what proposal_json holds).
    const d = await db();
    const now = Date.now();
    d.prepare(
      `INSERT INTO analysis_turns (turn_id, analysis_id, user_message, reply, proposal_json, impact_json, status, created_at)
       VALUES ('trn_gate', ?, 'Remove a obrigação de igualdade.', 'Removi a obrigação pedida.', ?, ?, 'pending_confirmation', ?)`,
    ).run(
      analysisId,
      JSON.stringify([{ heading: 'Documento', body: 'Texto revisto sem a obrigação.' }]),
      JSON.stringify({ reasons: ['A aplicação detetou a remoção de conteúdo com fonte: referência(s) [1] deixaram de ser citadas.'], appOverrode: true }),
      now,
    );
    d.prepare(`UPDATE analyses SET state = 'alteracao_pendente_de_confirmacao' WHERE analysis_id = ?`).run(analysisId);
    d.close();

    // While pending: new chat messages and approval are blocked.
    const blocked = await api(`/api/analyses/${analysisId}/chat`, { method: 'POST', body: { message: 'outra' }, jar });
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.error, /pendente/);
    const approveBlocked = await api(`/api/analyses/${analysisId}/approve`, { method: 'POST', jar });
    assert.equal(approveBlocked.status, 409);

    // Confirm → new immutable chat_change version, state back, turn applied.
    const confirmed = await api(`/api/analyses/${analysisId}/chat/trn_gate`, {
      method: 'PATCH',
      body: { decision: 'confirm' },
      jar,
    });
    assert.equal(confirmed.data.ok, true, JSON.stringify(confirmed.data));
    assert.equal(confirmed.data.turn.status, 'applied');
    assert.ok(confirmed.data.turn.versionId);

    const after1 = await api(`/api/analyses/${analysisId}/versions`, { jar });
    assert.equal(after1.data.versions.length, versionCountBefore + 1);
    const newest = after1.data.versions[after1.data.versions.length - 1];
    assert.equal(newest.origin, 'chat_change');
    assert.match(newest.note, /confirmada via chat/);

    const detail = await api(`/api/analyses/${analysisId}`, { jar });
    assert.equal(detail.data.analysis.state, 'pronta_para_revisao');
    assert.ok(detail.data.events.some((e) => e.kind === 'chat_change_confirmed'));
  });

  it('discard leaves NO new version and reopens the analysis', async () => {
    const jar = await loginAdmin();
    const before1 = await api(`/api/analyses/${analysisId}/versions`, { jar });
    const versionCountBefore = before1.data.versions.length;

    const d = await db();
    d.prepare(
      `INSERT INTO analysis_turns (turn_id, analysis_id, user_message, reply, proposal_json, impact_json, status, created_at)
       VALUES ('trn_discard', ?, 'Apaga tudo.', 'Proposta radical.', ?, '{}', 'pending_confirmation', ?)`,
    ).run(analysisId, JSON.stringify([{ heading: 'X', body: 'y' }]), Date.now());
    d.prepare(`UPDATE analyses SET state = 'alteracao_pendente_de_confirmacao' WHERE analysis_id = ?`).run(analysisId);
    d.close();

    const discarded = await api(`/api/analyses/${analysisId}/chat/trn_discard`, {
      method: 'PATCH',
      body: { decision: 'discard' },
      jar,
    });
    assert.equal(discarded.data.turn.status, 'discarded');
    assert.equal(discarded.data.turn.versionId, '');

    const after1 = await api(`/api/analyses/${analysisId}/versions`, { jar });
    assert.equal(after1.data.versions.length, versionCountBefore); // no version
    const detail = await api(`/api/analyses/${analysisId}`, { jar });
    assert.equal(detail.data.analysis.state, 'pronta_para_revisao');
    assert.ok(detail.data.events.some((e) => e.kind === 'chat_change_discarded'));

    // Deciding an already-decided turn 404s.
    const again = await api(`/api/analyses/${analysisId}/chat/trn_discard`, {
      method: 'PATCH',
      body: { decision: 'confirm' },
      jar,
    });
    assert.equal(again.status, 404);
  });

  it('§13 cross-check: the app gates an under-reporting model; honest/benign pass through', async () => {
    const { crossCheckProposal } = await loadTsModule('src/lib/server/chat-rules.ts');

    const oldSections = [
      { heading: 'Obrigações', body: 'Deve garantir a igualdade [1]. Deve comunicar até abril [2].' },
      { heading: 'Conclusão', body: 'Síntese final.' },
    ];

    // Poisoned turn: the model REMOVED cited content but claims total innocence.
    const underReporting = crossCheckProposal(
      oldSections,
      [{ heading: 'Obrigações', body: 'Deve garantir a igualdade [1].' }, { heading: 'Conclusão', body: 'Síntese final.' }],
      { removes_factual_content: false, alters_obligations_deadlines_references: false, requires_confirmation: false },
    );
    assert.equal(underReporting.gate, true);
    assert.equal(underReporting.appOverrode, true);
    assert.deepEqual(underReporting.removedMarkers, [2]);
    assert.ok(underReporting.reasons.some((r) => r.includes('[2]')));

    // Benign rewording that keeps every marker: no gate.
    const benign = crossCheckProposal(
      oldSections,
      [{ heading: 'Obrigações', body: 'A igualdade deve ser garantida [1], com comunicação até abril [2].' }, { heading: 'Conclusão', body: 'Nova síntese, mais curta.' }],
      { removes_factual_content: false, alters_obligations_deadlines_references: false, requires_confirmation: false },
    );
    assert.equal(benign.gate, false);
    assert.equal(benign.appOverrode, false);

    // The model's own honesty is enough to gate, even with markers intact.
    const honest = crossCheckProposal(oldSections, oldSections, {
      removes_factual_content: false,
      alters_obligations_deadlines_references: true,
      requires_confirmation: false,
    });
    assert.equal(honest.gate, true);
    assert.equal(honest.appOverrode, false);
  });
});
