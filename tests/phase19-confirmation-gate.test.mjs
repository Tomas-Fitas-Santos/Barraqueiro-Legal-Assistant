import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loadTsModule, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// §5.3 — the user confirms each related document INDIVIDUALLY, and generation cannot start
// until they have.
//
// The gate existed before this phase and asked the question with two of the six things §5.3
// says the answer needs: a name and a relation type. Version, date, reason, excerpts and
// relevância were either sitting unread in `relations.evidence_json` or did not exist. A
// confirmation the user cannot make an informed decision on is a rubber stamp, so what these
// tests pin is that the gate CARRIES its evidence — and that a library with no AI configured
// still bands every candidate, because the deterministic path is the one the client's
// install runs on until they connect ChatGPT.

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

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

describe('phase 19 — the §5.3 confirmation gate carries its evidence', () => {
  let jar;
  let analysisId;

  before(async () => {
    await startServer();
    jar = await loginAdmin();

    await seedDocument(jar, 'doc_main', 'Nota Interna Transparência Salarial.pdf', {
      title: 'Nota Interna Transparência Salarial',
      topics_json: JSON.stringify(['transparência salarial', 'igualdade de género']),
    });
    await seedDocument(jar, 'doc_rel', 'Política de Igualdade Salarial.pdf', {
      title: 'Política de Igualdade Salarial',
      version_label: 'v3',
      issued_date: '2024-05-17',
      topics_json: JSON.stringify(['transparência salarial', 'igualdade de género']),
    });

    const created = await api('/api/analyses', {
      method: 'POST',
      body: { type: 'revision', mainDocumentId: 'doc_main', instructions: 'Rever à luz da diretiva.' },
      jar,
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    analysisId = created.data.analysis.analysisId;

    const identified = await api(`/api/analyses/${analysisId}/identify-relations`, { method: 'POST', jar });
    assert.equal(identified.status, 200, JSON.stringify(identified.data));
  });

  after(async () => {
    await stopServer();
  });

  it('every pending document arrives with the six fields the decision needs', async () => {
    const { data } = await api(`/api/analyses/${analysisId}`, { jar });
    const pending = data.documents.find((doc) => doc.documentId === 'doc_rel');
    assert.ok(pending, `doc_rel was never proposed: ${JSON.stringify(data.documents)}`);

    assert.equal(pending.status, 'pending');
    assert.equal(pending.documentName, 'Política de Igualdade Salarial.pdf');
    assert.ok(pending.relationType, 'no relation type');
    // Which document this IS — two revisions of one policy differ by nothing else.
    assert.equal(pending.versionLabel, 'v3');
    assert.equal(pending.issuedDate, '2024-05-17');
    // Why the app thinks it belongs, and how much it would change the analysis.
    assert.ok(pending.reason, 'no reason given for the proposal');
    assert.ok(['alta', 'media', 'baixa'].includes(pending.relevance), `relevance was ${JSON.stringify(pending.relevance)}`);
  });

  it('bands relevance with no AI configured at all', async () => {
    // The suite runs entirely on the degraded path, so this passing IS the assertion that
    // relevância is the app's own judgement and not something only a model can produce.
    const { data } = await api(`/api/analyses/${analysisId}`, { jar });
    for (const doc of data.documents.filter((d) => d.role === 'related')) {
      assert.notEqual(doc.relevance, '', `${doc.documentId} has no band`);
    }
  });

  it('the document picked in the wizard is never labelled with its own identifier', async () => {
    const created = await api('/api/analyses', {
      method: 'POST',
      body: { type: 'revision', mainDocumentId: 'doc_main', relatedDocumentIds: ['doc_rel'], instructions: 'x' },
      jar,
    });
    const { data } = await api(`/api/analyses/${created.data.analysis.analysisId}`, { jar });
    const picked = data.documents.find((doc) => doc.documentId === 'doc_rel');
    assert.equal(picked.status, 'confirmed', 'a document the user chose by hand must not be re-asked');
    assert.equal(picked.relationType, 'selecionado_no_assistente');

    // ...and the gate turns that identifier into something a person reads. It used to
    // render 'selecionado_no_assistente' at the user verbatim.
    const types = await loadTsModule('src/lib/types.ts');
    assert.equal(types.relatedDocumentRelationLabel('selecionado_no_assistente'), 'escolhido por si');
    assert.equal(types.relatedDocumentRelationLabel('e_substituido_por'), 'é substituído por');
    assert.equal(types.relatedDocumentRelationLabel(''), '');
  });

  it('generation is blocked until every proposed document is decided', async () => {
    const blocked = await api(`/api/analyses/${analysisId}/run`, { method: 'POST', jar });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.data));

    const decided = await api(`/api/analyses/${analysisId}/documents/doc_rel`, {
      method: 'PATCH',
      body: { status: 'excluded' },
      jar,
    });
    assert.equal(decided.status, 200, JSON.stringify(decided.data));
    const after = decided.data.documents.find((doc) => doc.documentId === 'doc_rel');
    assert.equal(after.status, 'excluded');
    assert.ok(after.decidedAt > 0, 'an excluded document must record WHEN it was decided');
  });
});
