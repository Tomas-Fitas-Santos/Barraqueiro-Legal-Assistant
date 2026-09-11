import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// A relation is between two DOCUMENTS. It was stored as a directed edge, and the sweep
// walks every document, so the same link was recorded twice — «A cita B» while processing
// A, «B é citado por A» while processing B — and the library showed the pair twice, said
// the same thing in two grammatical directions, and asked to have it confirmed twice.

let jar;

async function openDb() {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
}

const EVIDENCE = JSON.stringify({
  deterministic: {
    referenceHits: [{ direction: 'from_cites_to', text: 'X', page: 2 }],
    titleMentions: [],
    topicOverlap: [],
    entityMatch: false,
    sameFolder: true,
    semantic: { score: 0.9, rank: 1 },
  },
  relevance: 'alta',
  ai: { rationale: 'porque sim' },
});

const WEAK = JSON.stringify({
  deterministic: {
    referenceHits: [],
    titleMentions: [],
    topicOverlap: [],
    entityMatch: false,
    sameFolder: true,
    semantic: { score: 0.85, rank: 3 },
  },
  relevance: 'baixa',
  ai: { rationale: 'tema comum' },
});

describe('a relation is a pair of documents, not a direction', () => {
  before(async () => {
    await startServer();
    jar = await loginAdmin();
    const db = await openDb();
    const now = Date.now();
    for (const [id, name] of [
      ['doc_pA', 'A.pdf'],
      ['doc_pB', 'B.pdf'],
      ['doc_pC', 'C.pdf'],
    ]) {
      db.prepare(
        `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
         VALUES (?, ?, ?, '', 'application/pdf', 0, 'indexed', 0, ?, ?, ?)`,
      ).run(id, `l-${id}`, name, now, now, now);
    }
    const ins = db.prepare(
      `INSERT INTO relations (relation_id, from_document_id, to_document_id, type, evidence_json, proposed_by, status, decided_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'ai', 'proposed', null, ?, ?)`,
    );
    ins.run('rel_p1', 'doc_pA', 'doc_pB', 'cita', EVIDENCE, now, now);
    // The same fact recorded from the other end — this is the duplicate.
    ins.run('rel_p2', 'doc_pB', 'doc_pA', 'e_citado_por', EVIDENCE, now, now);
    // A genuinely different reason for the same pair, which must survive as its own tag.
    ins.run('rel_p3', 'doc_pA', 'doc_pB', 'trata_o_mesmo_tema', WEAK, now, now);
    ins.run('rel_p4', 'doc_pC', 'doc_pA', 'complementa', WEAK, now, now);
    db.close();
  });
  after(async () => {
    await stopServer();
  });

  it('shows one relation per other document, with its reasons as tags', async () => {
    const detail = await api('/api/library/documents/doc_pA', { jar });
    const groups = detail.data.relations;
    assert.equal(groups.length, 2, 'the same pair is still listed more than once');
    const others = groups.map((g) => g.otherDocumentName).sort();
    assert.deepEqual(others, ['B.pdf', 'C.pdf']);

    const b = groups.find((g) => g.otherDocumentName === 'B.pdf');
    // `cita` and `e_citado_por` are one reason stated from two ends, so they collapse;
    // `trata_o_mesmo_tema` is a second reason and must not.
    assert.equal(b.motives.length, 2, `expected two motives, got ${b.motives.map((m) => m.type).join(', ')}`);
    assert.ok(b.motives.some((m) => m.type === 'cita'));
    assert.ok(b.motives.some((m) => m.type === 'trata_o_mesmo_tema'));
    assert.ok(!b.motives.some((m) => m.type === 'e_citado_por'), 'the inverse was kept as a separate reason');
  });

  it('never leaves a relation without a confidence band', async () => {
    // A band that can be absent renders as nothing at all, and "no badge" is indistinguishable
    // from "we did not check" — the failure this is here to prevent.
    const detail = await api('/api/library/documents/doc_pA', { jar });
    for (const group of detail.data.relations) {
      assert.ok(group.confidence?.level, `${group.otherDocumentName} has no confidence band`);
      assert.ok(group.confidence.basis, `${group.otherDocumentName} has a band with no reason given`);
      for (const motive of group.motives) {
        assert.ok(motive.confidence?.level, `${motive.type} has no confidence band`);
      }
    }
    // The pair's band is the strongest of its reasons: the best reason to believe the link.
    const b = detail.data.relations.find((g) => g.otherDocumentName === 'B.pdf');
    assert.equal(b.confidence.level, 'alta');
  });

  it('keeps the band after the relation has been decided', async () => {
    const before = await api('/api/library/documents/doc_pA', { jar });
    const pair = before.data.relations.find((g) => g.otherDocumentName === 'B.pdf');
    const res = await api(`/api/relations/${pair.relationId}`, { method: 'PATCH', body: { decision: 'confirmed' }, jar });
    assert.equal(res.data.ok, true, JSON.stringify(res.data));

    const after = await api('/api/library/documents/doc_pA', { jar });
    const decided = after.data.relations.find((g) => g.otherDocumentName === 'B.pdf');
    assert.equal(decided.status, 'confirmed');
    // Confirming a link does not turn the evidence behind it into something else.
    assert.equal(decided.confidence.level, 'alta');
    assert.ok(decided.confidence.basis);
  });

  it('decides the pair, not one of its reasons', async () => {
    // Deciding a single edge would leave the same pair confirmed and proposed at once.
    const db = await openDb();
    const rows = db
      .prepare("SELECT relation_id, status FROM relations WHERE relation_id IN ('rel_p1','rel_p2','rel_p3','rel_p4')")
      .all();
    db.close();
    const byId = Object.fromEntries(rows.map((r) => [r.relation_id, r.status]));
    assert.equal(byId.rel_p1, 'confirmed');
    assert.equal(byId.rel_p2, 'confirmed', 'the reverse row was left undecided');
    assert.equal(byId.rel_p3, 'confirmed', 'the pair’s other reason was left undecided');
    assert.equal(byId.rel_p4, 'proposed', 'a different pair was decided too');
  });

  it('a document chosen by hand in the wizard still carries a band', async () => {
    // It has no relation row behind it — there was nothing to read, the band came back
    // null, and a null band renders as nothing. A person deciding is the highest band
    // there is; it is what every proposal is trying to approximate.
    const created = await api('/api/analyses', {
      method: 'POST',
      body: { type: 'summary', mainDocumentId: 'doc_pA', relatedDocumentIds: ['doc_pC'] },
      jar,
    });
    assert.equal(created.data.ok, true, JSON.stringify(created.data));
    const analysis = await api(`/api/analyses/${created.data.analysis.analysisId}`, { jar });
    const related = analysis.data.documents.filter((d) => d.role === 'related');
    assert.ok(related.length > 0, 'the wizard choice was not recorded');
    for (const doc of related) {
      assert.ok(doc.confidence?.level, `${doc.documentName} has no confidence band`);
      assert.equal(doc.confidence.level, 'alta');
    }
  });
});
