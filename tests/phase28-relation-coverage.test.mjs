import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { api, BASE, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// Workstream F — relations stay correct as the library changes.
//
// The predecessor was `documents.relations_dirty`, a boolean that could only say "something
// changed somewhere". It could not survive a partial sweep, it re-judged pairs that had not
// moved, and nothing anywhere withdrew relations to a document that had left the library.

function openDb() {
  return new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
}

async function waitFor(check, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function seedDocument(jar, documentId, name, columns = {}) {
  const db = openDb();
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

  const db2 = openDb();
  for (const [column, value] of Object.entries(columns)) {
    db2.prepare(`UPDATE documents SET ${column} = ? WHERE document_id = ?`).run(value, documentId);
  }
  db2.close();
}

let jar;

describe('phase 28 — the pairwise coverage ledger', () => {
  before(async () => {
    await startServer();
    jar = await loginAdmin();
    await seedDocument(jar, 'doc_a', 'Política de Igualdade Salarial.pdf', {
      title: 'Política de Igualdade Salarial',
      topics_json: JSON.stringify(['transparência salarial', 'igualdade de género']),
    });
    await seedDocument(jar, 'doc_b', 'Diretiva Transparência Salarial.pdf', {
      title: 'Diretiva Transparência Salarial',
      topics_json: JSON.stringify(['transparência salarial', 'igualdade de género']),
    });
  });
  after(async () => {
    await stopServer();
  });

  it('the boolean is gone — nothing has to remember to set a flag', async () => {
    const db = openDb();
    const columns = db.prepare('PRAGMA table_info(documents)').all().map((c) => c.name);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
    db.close();
    assert.ok(tables.includes('relation_coverage'), 'the ledger does not exist');
    assert.ok(
      !columns.includes('relations_dirty'),
      'the dirty flag is still being created — two sources of truth for the same question',
    );
  });

  it('records which pairs were compared, and at which content', async () => {
    const covered = await waitFor(async () => {
      const db = openDb();
      const rows = db.prepare('SELECT * FROM relation_coverage').all();
      db.close();
      return rows.length >= 2 ? rows : null;
    });
    assert.ok(covered, 'the sweep never recorded any coverage');
    for (const row of covered) {
      assert.ok(row.from_fingerprint.length > 0, 'a pair recorded with no fingerprint on one end');
      assert.ok(row.to_fingerprint.length > 0);
      assert.notEqual(row.from_document_id, row.to_document_id);
      assert.ok(row.computed_at > 0);
    }
  });

  it('an edit to what the comparison reads makes the pair uncompared again', async () => {
    // The failure this replaces: a fingerprint over the file bytes alone. The classifier
    // writes the title, entity, topics and references AFTER ingest, and a user can correct
    // them (§8) — all of which the comparison runs on. A byte hash would call the pair
    // covered while the inputs had changed underneath it.
    const db = openDb();
    const before = db.prepare('SELECT from_document_id, from_fingerprint FROM relation_coverage LIMIT 1').get();
    assert.ok(before, 'nothing covered to edit');
    db.prepare('UPDATE documents SET title = ? WHERE document_id = ?').run(
      'Um título que a comparação vai ler',
      before.from_document_id,
    );
    db.close();

    const changed = await waitFor(async () => {
      await api(`/api/library/documents/${before.from_document_id}/relations/propose`, { method: 'POST', jar });
      const d = openDb();
      const row = d
        .prepare('SELECT from_fingerprint FROM relation_coverage WHERE from_document_id = ? LIMIT 1')
        .get(before.from_document_id);
      d.close();
      return row && row.from_fingerprint !== before.from_fingerprint ? row : null;
    }, 30_000);
    assert.ok(changed, 'the fingerprint did not follow a change to the title the comparison reads');
  });

  it('a removed document stops appearing in anyone’s relations', async () => {
    const db = openDb();
    const edge = db
      .prepare(
        `SELECT r.relation_id, r.from_document_id, r.to_document_id FROM relations r
           JOIN documents d ON d.document_id = r.to_document_id
          WHERE d.removed = 0 LIMIT 1`,
      )
      .get();
    db.close();
    assert.ok(edge, 'no relation to remove one end of');

    const before = await api(`/api/library/documents/${edge.from_document_id}/relations`, { jar });
    assert.ok(
      before.data.relations.some((r) => r.toDocumentId === edge.to_document_id),
      'the edge was not visible to begin with',
    );

    const db2 = openDb();
    db2.prepare('UPDATE documents SET removed = 1 WHERE document_id = ?').run(edge.to_document_id);
    db2.close();

    const after = await api(`/api/library/documents/${edge.from_document_id}/relations`, { jar });
    assert.ok(
      !after.data.relations.some((r) => r.toDocumentId === edge.to_document_id),
      'a relation still points at a document that has left the library',
    );

    // The row is KEPT, not deleted: the withdrawal is a read-time rule, so if the document
    // comes back the user's decision comes back with it instead of being asked again.
    const db3 = openDb();
    const stillThere = db3.prepare('SELECT status FROM relations WHERE relation_id = ?').get(edge.relation_id);
    db3.prepare('UPDATE documents SET removed = 0 WHERE document_id = ?').run(edge.to_document_id);
    db3.close();
    assert.ok(stillThere, 'the decision was destroyed rather than withdrawn');

    const restored = await api(`/api/library/documents/${edge.from_document_id}/relations`, { jar });
    assert.ok(
      restored.data.relations.some((r) => r.toDocumentId === edge.to_document_id),
      'the relation did not come back with the document',
    );
  });
});
