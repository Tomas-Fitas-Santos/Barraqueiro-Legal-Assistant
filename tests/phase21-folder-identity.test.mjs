import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loadTsModule, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// Workstream E — each of the three library folders is its own kind of thing.
//
// Before this, the same five tabs and the same processing were applied to all three: a
// template was offered a Metadados panel it can never fill, and a generated document could
// be picked as the other end of a documental relation, mixing provenance (known) with
// judgement (inferred). The kind is now derived once from the path and everything reads it.

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

async function db() {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
}

async function authedFetch(jar, p, init = {}) {
  return fetch(`${BASE}${p}`, {
    ...init,
    headers: { ...(init.headers || {}), cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
}

async function fileRows(jar) {
  const list = await api('/api/library/list?recursive=1&limit=200', { jar });
  return (list.data.files || []).slice();
}

let jar;

describe('workstream E — the three folders are three different things', () => {
  before(async () => {
    await startServer();
    jar = await loginAdmin();
    await api('/api/msgraph/folder', {
      method: 'POST',
      body: { folderId: 'fake-root', folderName: 'fake-onedrive' },
      jar,
    });
    await api('/api/library/sync', { method: 'POST', jar });

    const bytes = readFileSync(path.join(FIXTURES, 'nota-interna-transparencia-salarial.pdf'));
    const d = await db();
    const now = Date.now();
    d.prepare(
      `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
       VALUES ('doc_src', 'local-doc_src', 'Nota Interna.pdf', ?, 'application/pdf', 0, 'listed', 0, ?, ?, ?)`,
    ).run('1. Documentos oficiais Barraqueiro', now, now, now);
    // A generated document, without running an analysis: what matters here is where it sits.
    d.prepare(
      `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
       VALUES ('doc_gen', 'local-doc_gen', 'Nota_X_v1a_final.pdf', ?, 'application/pdf', 0, 'listed', 0, ?, ?, ?)`,
    ).run('3. Documentos gerados/Resumo documental/Resumo documental — X (aaaaaa)', now, now, now);
    d.close();
    for (const id of ['doc_src', 'doc_gen']) {
      await authedFetch(jar, `/api/library/documents/${id}/original`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes,
      });
    }
  });
  after(async () => {
    await stopServer();
  });

  it('derives exactly one kind per path', async () => {
    const layout = await loadTsModule('src/lib/library-layout.ts');
    assert.equal(layout.documentKind('1. Documentos oficiais Barraqueiro/x.pdf'), 'official');
    assert.equal(layout.documentKind('2. Templates/Resumo documental/t.docx'), 'template');
    assert.equal(layout.documentKind('3. Documentos gerados/Resumo documental/a/o.pdf'), 'generated');
    assert.equal(layout.documentKind('Documentos gerados (Assistente Jurídico)/o.pdf'), 'generated');
    // Anything the app did not put there is the client's own material, including the root.
    assert.equal(layout.documentKind(''), 'official');
    // A sibling that merely starts the same way is NOT the folder.
    assert.equal(layout.documentKind('3. Documentos gerados antigos/x.pdf'), 'official');

    assert.equal(layout.isReadableDocument('1. Documentos oficiais Barraqueiro/x.pdf'), true);
    assert.equal(layout.isReadableDocument('2. Templates/Resumo documental/t.docx'), false);
    assert.equal(layout.isReadableDocument('3. Documentos gerados/a/o.pdf'), false);
  });

  it('tells the library list what each file IS, not how far it got', async () => {
    const rows = await fileRows(jar);
    assert.ok(rows.length > 0, 'the library listed no files');
    for (const row of rows) {
      assert.ok(
        ['official', 'template', 'generated'].includes(row.documentKind),
        `row ${row.name} has no documentKind`,
      );
    }
    assert.equal(rows.find((r) => r.path.startsWith('2. Templates')).documentKind, 'template');
    assert.equal(rows.find((r) => r.name === 'Nota Interna.pdf').documentKind, 'official');
    assert.equal(rows.find((r) => r.name === 'Nota_X_v1a_final.pdf').documentKind, 'generated');
  });

  it('does not read a template or a generated document as a document', async () => {
    const rows = await fileRows(jar);
    const template = rows.find((r) => r.path.startsWith('2. Templates'));

    for (const id of [template.documentId, 'doc_gen']) {
      const res = await api(`/api/library/documents/${id}/ingest`, { method: 'POST', jar });
      assert.equal(res.status, 200);
      assert.equal(res.data.result.skipped, true, `${id} was put through the reading pipeline`);
    }

    const detail = await api(`/api/library/documents/${template.documentId}`, { jar });
    assert.equal(detail.data.document.pageCount, 0, 'a template got pages');
    assert.equal(detail.data.relations.length, 0, 'a template got relations');
  });

  it('never offers a template or a generated document as the other end of a relation', async () => {
    const mod = await loadTsModule('src/lib/library-layout.ts');
    const rows = await fileRows(jar);
    // The picker filters on exactly this, so the guarantee is asserted where it is decided.
    const offered = rows.filter((r) => mod.documentKind(r.path) === 'official').map((r) => r.name);
    assert.ok(offered.includes('Nota Interna.pdf'));
    assert.ok(!offered.includes('Nota_X_v1a_final.pdf'), 'a generated document was offered as relatable');
    assert.ok(!offered.some((n) => n.endsWith('.docx')), 'a template was offered as relatable');
  });

  it('resolves an analysis output to the library page of the file it produced', async () => {
    // Asserted through the detail API, which is where the UI reads it from.
    const d = await db();
    const now = Date.now();
    d.prepare(
      `INSERT INTO analyses (analysis_id, type, main_document_id, state, created_at, updated_at)
       VALUES ('ana_e1', 'summary', 'doc_src', 'pronta_para_revisao', ?, ?)`,
    ).run(now, now);
    d.prepare(
      `INSERT INTO analysis_documents (analysis_id, document_id, role, status)
       VALUES ('ana_e1', 'doc_src', 'main', 'confirmed')`,
    ).run();
    d.prepare(
      `INSERT INTO analysis_versions (version_id, analysis_id, version_no, origin, sha256, filename, template_id, template_version, created_at)
       VALUES ('ver_e1', 'ana_e1', 1, 'generated', '', 'Nota_X_v1a.docx', 'nota_resumo', 1, ?)`,
    ).run(now);
    d.prepare(
      `INSERT INTO conversions (conversion_id, analysis_id, version_id, docx_sha256, state, pdf_filename, onedrive_pdf_id, created_at, updated_at)
       VALUES ('cnv_e1', 'ana_e1', 'ver_e1', '', 'pronto_para_revisao', 'Nota_X_v1a_final.pdf', 'local-doc_gen', ?, ?)`,
    ).run(now, now);
    d.close();

    const detail = await api('/api/library/documents/doc_src', { jar });
    const analysis = detail.data.analyses.find((a) => a.analysisId === 'ana_e1');
    assert.ok(analysis, 'the analysis that used this document was not listed');
    assert.equal(analysis.role, 'main');
    assert.equal(
      analysis.outputs[0].documentId,
      'doc_gen',
      'the output was not resolved to its own library document',
    );
  });
});
