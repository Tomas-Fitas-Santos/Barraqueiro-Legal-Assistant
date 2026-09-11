import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

const CONFIRMATION = 'REMOVER_TODAS_AS_ANALISES_E_RESULTADOS_EXCLUSIVOS';
async function db() {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
}

let jar;

describe('phase 36 — production cleanup is dry-run and exact-hash gated', () => {
  before(async () => {
    await startServer();
    jar = await loginAdmin();
    const d = await db();
    const now = Date.now();
    for (const row of [
      ['doc_keep_a', 'keep-a', 'Regulamento A.pdf', '1. Documentos oficiais Barraqueiro/Regulamento A.pdf', 'sha-a'],
      ['doc_keep_b', 'keep-b', 'Regulamento B.pdf', '1. Documentos oficiais Barraqueiro/Regulamento B.pdf', 'sha-b'],
      ['doc_remove', 'generated-docx', 'Nota_v1a.docx', '3. Resultados/Resumo documental/Nota/Nota_v1a.docx', 'sha-docx'],
    ]) {
      d.prepare(
        `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, sha256, state, removed, synced_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'application/pdf', 10, ?, 'indexed', 0, ?, ?, ?)`,
      ).run(...row, now, now, now);
    }
    d.prepare(
      `INSERT INTO relations (relation_id, from_document_id, to_document_id, type, status, proposed_by, created_at, updated_at)
       VALUES ('rel_keep', 'doc_keep_a', 'doc_keep_b', 'complements', 'confirmed', 'user', ?, ?)`,
    ).run(now, now);
    d.prepare(
      `INSERT INTO analyses (analysis_id, type, main_document_id, state, created_at, updated_at)
       VALUES ('ana_remove', 'summary', 'doc_keep_a', 'aprovada', ?, ?)`,
    ).run(now, now);
    d.prepare(
      `INSERT INTO analysis_versions (version_id, analysis_id, version_no, origin, sha256, filename, is_final, created_at)
       VALUES ('ver_remove', 'ana_remove', 1, 'generated', 'sha-docx', 'Nota_v1a.docx', 1, ?)`,
    ).run(now);
    d.prepare(
      `INSERT INTO conversions (conversion_id, analysis_id, version_id, docx_sha256, onedrive_docx_id, state, created_at, updated_at)
       VALUES ('cnv_remove', 'ana_remove', 'ver_remove', 'sha-docx', 'generated-docx', 'aprovado_para_envio', ?, ?)`,
    ).run(now, now);
    d.close();
  });
  after(async () => stopServer());

  it('does not mutate on inventory or a vague confirmation', async () => {
    const dry = await api('/api/maintenance/analysis-cleanup', { jar });
    assert.equal(dry.status, 200, JSON.stringify(dry.data));
    assert.equal(dry.data.inventory.analyses.length, 1);
    assert.equal(dry.data.inventory.exclusiveLibraryDocuments.length, 1);
    assert.equal(dry.data.inventory.preserveCounts.confirmedRelations, 1);

    const refused = await api('/api/maintenance/analysis-cleanup', {
      method: 'POST', body: { inventoryHash: dry.data.inventory.inventoryHash, confirmation: 'sim' }, jar,
    });
    assert.equal(refused.status, 400);
    const d = await db();
    assert.equal(d.prepare('SELECT COUNT(*) n FROM analyses').get().n, 1);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM documents').get().n, 3);
    d.close();
  });

  it('removes only the exact dry-run scope and preserves official data and relations', async () => {
    const dry = await api('/api/maintenance/analysis-cleanup', { jar });
    const done = await api('/api/maintenance/analysis-cleanup', {
      method: 'POST',
      body: { inventoryHash: dry.data.inventory.inventoryHash, confirmation: CONFIRMATION },
      jar,
    });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    const d = await db();
    assert.equal(d.prepare('SELECT COUNT(*) n FROM analyses').get().n, 0);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM conversions').get().n, 0);
    assert.equal(d.prepare("SELECT COUNT(*) n FROM documents WHERE path LIKE '1. Documentos oficiais Barraqueiro/%'").get().n, 2);
    assert.equal(d.prepare("SELECT COUNT(*) n FROM documents WHERE path LIKE '3. Resultados/%'").get().n, 0);
    assert.equal(d.prepare("SELECT COUNT(*) n FROM relations WHERE status = 'confirmed'").get().n, 1);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
    d.close();
  });
});
