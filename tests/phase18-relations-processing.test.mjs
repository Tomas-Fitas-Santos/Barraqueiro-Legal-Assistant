import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// §7 step 10 — relations computed WHILE a document is processed.
//
// What makes this phase worth testing is not that relations appear; phase 3 already proved
// that. It is the cost shape. Done naively, a 500-file sync means half a million evidence
// gatherings and one AI judgement per document per sync, and the app would be unusable on
// the client's real library. So the tests below pin the three properties that keep it cheap:
// the shortlist exists before anyone asks for it, a second sweep over an unchanged library
// judges nothing, and a title made of common words is still found inside the document that
// mentions it.

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

/** The sweep is deliberately a background pass, so the tests wait for it rather than call it. */
async function waitFor(check, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== null && value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function countRelations() {
  const db = await openDb();
  const n = db.prepare('SELECT COUNT(*) AS n FROM relations').get().n;
  db.close();
  return n;
}

async function openDb() {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
}

async function seedDocument(jar, documentId, name, columns = {}) {
  const db = await openDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
     VALUES (?, ?, ?, '', 'application/pdf', 0, 'listed', 0, ?, ?, ?)`,
  ).run(documentId, `local-${documentId}`, name, now, now, now);
  db.close();

  const res = await fetch(`${BASE}/api/library/documents/${documentId}/original`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    },
    body: readFileSync(path.join(FIXTURES, 'nota-interna-transparencia-salarial.pdf')),
  });
  assert.equal(res.status, 200, JSON.stringify(await res.json()));

  if (Object.keys(columns).length > 0) {
    const db2 = await openDb();
    for (const [column, value] of Object.entries(columns)) {
      db2.prepare(`UPDATE documents SET ${column} = ? WHERE document_id = ?`).run(value, documentId);
    }
    db2.close();
  }
}

describe('phase 18 — relations are ready before anyone asks', () => {
  let jar;
  before(async () => {
    await startServer();
    jar = await loginAdmin();
  });
  after(async () => {
    await stopServer();
  });

  it('processing a document leaves its shortlist cached, without a proposal run', async () => {
    await seedDocument(jar, 'doc_a', 'Política de Igualdade Salarial.pdf', {
      title: 'Política de Igualdade Salarial',
      topics_json: JSON.stringify(['transparência salarial', 'igualdade de género']),
    });
    await seedDocument(jar, 'doc_b', 'Diretiva Transparência Salarial.pdf', {
      title: 'Diretiva Transparência Salarial',
      topics_json: JSON.stringify(['transparência salarial', 'igualdade de género']),
    });

    // Nobody has pressed "propose" and no analysis has started. The shortlist exists
    // because the documents were PROCESSED — which is the whole point of step 10 being a
    // processing step rather than something an analysis discovers.
    const cached = await waitFor(async () => {
      const db = await openDb();
      const rows = db.prepare('SELECT to_document_id FROM relation_candidates WHERE from_document_id = ?').all('doc_b');
      db.close();
      return rows.some((row) => row.to_document_id === 'doc_a') ? rows : null;
    });
    assert.ok(cached, "expected doc_a on doc_b's shortlist after processing alone");
  });

  it('the sweep proposes relations without anyone opening the document', async () => {
    const relations = await waitFor(async () => {
      const db = await openDb();
      const rows = db.prepare('SELECT from_document_id, to_document_id FROM relations').all();
      db.close();
      return rows.length > 0 ? rows : null;
    });
    assert.ok(relations, 'the background sweep never proposed anything');
  });

  it('a second sweep over an unchanged library judges nothing again', async () => {
    const before = await countRelations();

    // Re-processing changes doc_a's fingerprint, so every pair it is an end of is
    // uncompared again — one document changes what all the others are closest to. The
    // shortlists are refreshed, cheaply and without AI, but every pair on them has already
    // been judged, so no judgement runs. This is the difference between one AI call per sync
    // and one per document per sync, and on the client's real library it is the difference
    // between usable and not.
    const startedAt = Date.now();
    const again = await api('/api/library/documents/doc_a/ingest', { method: 'POST', body: { force: true }, jar });
    assert.equal(again.data.ok, true, JSON.stringify(again.data));
    await waitFor(async () => {
      const db = await openDb();
      const fresh = db
        .prepare('SELECT COUNT(*) AS n FROM relation_coverage WHERE from_document_id = ? AND computed_at >= ?')
        .get('doc_a', startedAt).n;
      db.close();
      return fresh > 0 ? true : null;
    });
    assert.equal(await countRelations(), before, 'a sweep over an already-judged library proposed again');
  });

  it('finds a title made of common words inside the document that mentions it', async () => {
    // The old shortlist took the GLOBAL top-5 segment hits and only then asked which
    // document they were in, so a title like this one — every word of which appears in
    // every document in the library — matched five unrelated segments and the real mention
    // was invisible. The search is now grouped by document instead of truncated before it.
    const db = await openDb();
    db.prepare("UPDATE documents SET title = ? WHERE document_id = 'doc_a'").run(
      'Princípio do trabalho igual, salário igual',
    );
    db.close();

    const { data } = await api('/api/library/documents/doc_a/relations/propose', { method: 'POST', jar });
    assert.equal(data.ok, true, JSON.stringify(data));
    const db2 = await openDb();
    const row = db2
      .prepare('SELECT evidence_json FROM relation_candidates WHERE from_document_id = ? AND to_document_id = ?')
      .get('doc_a', 'doc_b');
    db2.close();
    assert.ok(row, 'doc_b should be a candidate of doc_a');
    const evidence = JSON.parse(row.evidence_json);
    assert.ok(
      evidence.titleMentions.length > 0,
      `expected the title mention to be found, evidence was ${row.evidence_json}`,
    );
    assert.equal(evidence.titleMentions[0].inDocumentId, 'doc_b');
  });

  it('every relation the app shows says how sure it is, and why', async () => {
    // Workstream G, end to end. The no-AI path is the one that runs here, and it is exactly
    // the path where a band could most easily have been left blank.
    const { data } = await api('/api/library/documents/doc_a/relations', { jar });
    assert.ok(data.relations.length > 0, 'no relations to inspect');
    for (const rel of data.relations) {
      assert.ok(rel.confidence, `relation ${rel.relationId} has no confidence`);
      assert.ok(
        ['alta', 'media', 'baixa', 'nao_confirmada'].includes(rel.confidence.level),
        `unexpected band ${rel.confidence.level}`,
      );
      assert.ok(rel.confidence.basis.length > 10, 'a band with nothing behind it');
    }
  });
});
