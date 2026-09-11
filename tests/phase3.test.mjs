import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loadTsModule, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// Phase 3 — documental relations, without any model call: the deterministic shortlist
// from the app's own evidence (classification references + verified title mentions), the
// degraded heuristic run, confirm/reject persistence, and the §9 exact-reference rule as
// a unit test over the shipped leaf module.

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

async function db() {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
}

async function insertDocRow(documentId, name, extra = {}) {
  const d = await db();
  const now = Date.now();
  d.prepare(
    `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
     VALUES (?, ?, ?, '', 'application/pdf', 0, 'listed', 0, ?, ?, ?)`,
  ).run(documentId, `local-${documentId}`, name, now, now, now);
  for (const [column, value] of Object.entries(extra)) {
    d.prepare(`UPDATE documents SET ${column} = ? WHERE document_id = ?`).run(value, documentId);
  }
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

describe('phase 3 — relations engine (no model calls)', () => {
  before(async () => {
    await startServer();
    const jar = await loginAdmin();
    // Two indexed documents with a classification-reference from PPRC to the Código —
    // the exact shape the live pair produced, seeded deterministically.
    await insertDocRow('doc_pprc', 'PPRC.pdf');
    await uploadFixture(jar, 'doc_pprc', 'nota-interna-transparencia-salarial.pdf');
    await insertDocRow('doc_codigo', 'Código de Conduta.pdf');
    await uploadFixture(jar, 'doc_codigo', 'nota-interna-transparencia-salarial.pdf');

    const d = await db();
    d.prepare(
      `UPDATE documents SET title = 'Plano de Prevenção de Riscos de Corrupção', topics_json = ?, references_json = ? WHERE document_id = 'doc_pprc'`,
    ).run(
      JSON.stringify(['prevenção da corrupção', 'cumprimento normativo']),
      JSON.stringify([
        { text: 'Código de Conduta', citation: { document_id: 'doc_pprc', page: 4, excerpt: 'Código de Conduta' } },
      ]),
    );
    d.prepare(
      `UPDATE documents SET title = 'Código de Conduta', topics_json = ? WHERE document_id = 'doc_codigo'`,
    ).run(JSON.stringify(['ética profissional', 'prevenção da corrupção']));
    d.close();
  });
  after(async () => {
    await stopServer();
  });

  it('gates the relation APIs on the session', async () => {
    for (const [method, p] of [
      ['GET', '/api/library/documents/doc_pprc/relations'],
      ['POST', '/api/library/documents/doc_pprc/relations'],
      ['POST', '/api/library/documents/doc_pprc/relations/propose'],
      ['PATCH', '/api/relations/rel_x'],
    ]) {
      const res = await api(p, { method });
      assert.equal(res.status, 401, `${method} ${p}`);
    }
  });

  it('degraded proposal run: reference-backed cita from the app evidence, marked heuristic', async () => {
    const jar = await loginAdmin();
    const run = await api('/api/library/documents/doc_pprc/relations/propose', { method: 'POST', jar });
    assert.equal(run.data.ok, true, JSON.stringify(run.data));
    assert.equal(run.data.run.judged, false); // no AI in the harness
    assert.ok(run.data.run.shortlisted >= 1);

    const rels = run.data.relations;
    const cita = rels.find((r) => r.toDocumentId === 'doc_codigo' && r.type === 'cita');
    assert.ok(cita, `expected a cita proposal, got ${JSON.stringify(rels)}`);
    assert.equal(cita.status, 'proposed');
    assert.equal(cita.proposedBy, 'engine');
    assert.ok(String(cita.evidence.heuristic || '').includes('sem julgamento AI'));
    assert.ok(Array.isArray(cita.evidence.deterministic.referenceHits));
    assert.equal(cita.evidence.deterministic.referenceHits[0].direction, 'from_cites_to');
  });

  it('confirm and reject persist and order the list', async () => {
    const jar = await loginAdmin();
    const list = await api('/api/library/documents/doc_pprc/relations', { jar });
    const first = list.data.relations[0];
    const confirmed = await api(`/api/relations/${first.relationId}`, {
      method: 'PATCH',
      body: { decision: 'confirmed' },
      jar,
    });
    assert.equal(confirmed.data.relation.status, 'confirmed');
    assert.ok(confirmed.data.relation.decidedAt > 0);

    const again = await api('/api/library/documents/doc_pprc/relations', { jar });
    assert.equal(again.data.relations[0].status, 'confirmed');

    const bad = await api('/api/relations/rel_nope', { method: 'PATCH', body: { decision: 'confirmed' }, jar });
    assert.equal(bad.status, 404);
  });

  it('manual relations are born confirmed; self-relations refused', async () => {
    const jar = await loginAdmin();
    const added = await api('/api/library/documents/doc_codigo/relations', {
      method: 'POST',
      body: { toDocumentId: 'doc_pprc', type: 'serve_de_evidencia_para' },
      jar,
    });
    assert.equal(added.data.relation.status, 'confirmed');
    assert.equal(added.data.relation.proposedBy, 'user');

    const self = await api('/api/library/documents/doc_codigo/relations', {
      method: 'POST',
      body: { toDocumentId: 'doc_codigo', type: 'cita' },
      jar,
    });
    assert.equal(self.status, 400);

    const badType = await api('/api/library/documents/doc_codigo/relations', {
      method: 'POST',
      body: { toDocumentId: 'doc_pprc', type: 'melhora' },
      jar,
    });
    assert.equal(badType.status, 400);
  });

  it('§9 rule: a strong claim without an exact reference is downgraded, never accepted', async () => {
    const { enforceRelationRules } = await loadTsModule('src/lib/server/relations-rules.ts');

    const strongClaim = {
      to_document_id: 'doc_x',
      type: 'altera',
      rationale: 'Parecem tratar do mesmo assunto.',
      evidence_document_id: '',
      evidence_page: 0,
      evidence_excerpt: '',
    };

    const noEvidence = enforceRelationRules(strongClaim, { exactReferenceHit: false, aiEvidenceVerified: false });
    assert.equal(noEvidence.type, 'trata_o_mesmo_tema');
    assert.equal(noEvidence.enforced, true);
    assert.match(noEvidence.enforcementNote, /referência exata/);

    const withReference = enforceRelationRules(strongClaim, { exactReferenceHit: true, aiEvidenceVerified: false });
    assert.equal(withReference.type, 'altera');
    assert.equal(withReference.enforced, false);

    const withVerifiedAiEvidence = enforceRelationRules(strongClaim, { exactReferenceHit: false, aiEvidenceVerified: true });
    assert.equal(withVerifiedAiEvidence.type, 'altera');

    const weakClaim = enforceRelationRules(
      { ...strongClaim, type: 'trata_o_mesmo_tema' },
      { exactReferenceHit: false, aiEvidenceVerified: false },
    );
    assert.equal(weakClaim.enforced, false);
  });
});
