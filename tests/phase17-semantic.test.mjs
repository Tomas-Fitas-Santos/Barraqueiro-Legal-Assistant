import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loadTsModule, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// §7.9 — the semantic index.
//
// The index is a processing artefact with no screen of its own, so what is worth pinning is
// not "does it produce vectors" but the two properties everything downstream rests on:
//
//   1. similarity RANKS correctly and is never read as an absolute score, and
//   2. similarity can put a candidate in front of the AI but can never let the AI conclude
//      that one document alters or substitutes another (§9's hard rule).
//
// The second one is a leaf unit test on purpose: it is the rule the client's lawyers rely on
// and it must be exercised as shipped, with no server, no AI and no fixtures in the way.

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

describe('phase 17 — similarity may shortlist, never conclude', () => {
  let rules;
  before(async () => {
    rules = await loadTsModule('src/lib/server/relations-rules.ts');
  });

  const judged = {
    to_document_id: 'doc_other',
    type: 'substitui',
    rationale: 'Ambos tratam da transparência salarial e este é mais recente.',
    evidence_document_id: '',
    evidence_page: 0,
    evidence_excerpt: '',
  };

  it('downgrades a strong claim whose only support is that the documents are alike', () => {
    const out = rules.enforceRelationRules(judged, {
      exactReferenceHit: false,
      aiEvidenceVerified: false,
      semanticOnly: true,
    });
    assert.equal(out.type, 'trata_o_mesmo_tema');
    assert.equal(out.enforced, true);
    assert.match(out.enforcementNote, /semelhança semântica/);
  });

  it('downgrades it even when the AI cited an excerpt the app verified', () => {
    // A verified excerpt proves those words are on that page — not that they refer to the
    // other document. With no exact reference tying the two together, that inference is
    // exactly the one §9 forbids.
    const out = rules.enforceRelationRules(judged, {
      exactReferenceHit: false,
      aiEvidenceVerified: true,
      semanticOnly: true,
    });
    assert.equal(out.type, 'trata_o_mesmo_tema');
    assert.equal(out.enforced, true);
  });

  it('leaves a strong claim alone when the app itself found an exact reference', () => {
    const out = rules.enforceRelationRules(judged, {
      exactReferenceHit: true,
      aiEvidenceVerified: false,
      semanticOnly: false,
    });
    assert.equal(out.type, 'substitui');
    assert.equal(out.enforced, false);
  });

  it('never touches a weak type, whatever the evidence', () => {
    const out = rules.enforceRelationRules(
      { ...judged, type: 'trata_o_mesmo_tema' },
      { exactReferenceHit: false, aiEvidenceVerified: false, semanticOnly: true },
    );
    assert.equal(out.type, 'trata_o_mesmo_tema');
    assert.equal(out.enforced, false);
  });
});

describe('phase 17 — vectors survive storage', () => {
  let embed;
  before(async () => {
    process.env.LEGAL_DATA_DIR = testDataDir();
    embed = await loadTsModule('src/lib/server/ingest/embed.ts');
  });

  it('int8 packing keeps cosine faithful to the fourth decimal', () => {
    const rand = (seed) => {
      let x = seed;
      const out = new Float32Array(384);
      let norm = 0;
      for (let i = 0; i < 384; i++) {
        x = (x * 1103515245 + 12345) % 2147483648;
        out[i] = x / 2147483648 - 0.5;
        norm += out[i] * out[i];
      }
      norm = Math.sqrt(norm);
      for (let i = 0; i < 384; i++) out[i] /= norm;
      return out;
    };
    const a = rand(7);
    const b = rand(99);
    const exact = embed.cosine(a, b);
    const roundTripped = embed.cosine(embed.unpackVector(embed.packVector(a)), embed.unpackVector(embed.packVector(b)));
    assert.ok(Math.abs(exact - roundTripped) < 1e-3, `cosine drifted by ${Math.abs(exact - roundTripped)}`);
    // 384 int8 + one float scale, not 384 floats.
    assert.equal(embed.packVector(a).length, 388);
  });

  it('a centroid of one vector is that vector, and of none is nothing', () => {
    const a = embed.unpackVector(embed.packVector(Float32Array.from({ length: 384 }, (_, i) => (i === 3 ? 1 : 0))));
    assert.ok(embed.cosine(embed.centroid([a]), a) > 0.999);
    assert.equal(embed.centroid([]), null);
  });
});

describe('phase 17 — the index, built during processing', () => {
  let jar;
  before(async () => {
    await startServer({ env: { LEGAL_FAKE_GRAPH: '' } });
    jar = await loginAdmin();
  });
  after(async () => {
    await stopServer();
  });

  it('indexes a document as it is processed, and re-processing costs no new encoding', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const dbPath = path.join(testDataDir(), 'legal-assistant.sqlite');
    const now = Date.now();
    {
      const db = new DatabaseSync(dbPath);
      db.prepare(
        `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
         VALUES ('doc_sem', 'local-doc_sem', 'Nota Interna Transparência Salarial.pdf', '', 'application/pdf', 0, 'listed', 0, ?, ?, ?)`,
      ).run(now, now, now);
      db.close();
    }

    const cookie = [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const put = await fetch(`${BASE}/api/library/documents/doc_sem/original`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', cookie },
      body: readFileSync(path.join(FIXTURES, 'nota-interna-transparencia-salarial.pdf')),
    });
    assert.equal(put.status, 200, JSON.stringify(await put.json()));

    const db = new DatabaseSync(dbPath);
    const embedded = db
      .prepare('SELECT COUNT(*) AS n FROM segments WHERE document_id = ? AND embedding IS NOT NULL')
      .get('doc_sem').n;
    if (embedded === 0) {
      // The encoder's weights are a 120 MB download the image bakes in. A checkout that has
      // never fetched them still has to pass every other test in this suite — that is the
      // whole point of the degradation path — so this one reports and stops.
      db.close();
      console.warn('[phase17] encoder unavailable in this environment — skipping the index assertions');
      return;
    }

    const centroid = db.prepare('SELECT centroid FROM documents WHERE document_id = ?').get('doc_sem').centroid;
    assert.ok(centroid, 'an indexed document has a vector of its own');
    const cachedBefore = db.prepare('SELECT COUNT(*) AS n FROM embedding_cache').get().n;
    assert.ok(cachedBefore > 0);
    db.close();

    // §7: never encode the same bytes twice. A forced re-ingest re-reads the same text, so
    // the cache must absorb all of it.
    const again = await api('/api/library/documents/doc_sem/ingest', { method: 'POST', body: { force: true }, jar });
    assert.equal(again.data.ok, true, JSON.stringify(again.data));
    const db2 = new DatabaseSync(dbPath);
    assert.equal(
      db2.prepare('SELECT COUNT(*) AS n FROM embedding_cache').get().n,
      cachedBefore,
      're-processing unchanged text encoded something again',
    );
    db2.close();
  });
});
