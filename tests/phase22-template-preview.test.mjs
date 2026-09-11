import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// Workstream B1 — "pressing view downloads the document" (ClickUp issue 2).
//
// A template is deliberately kept out of the reading pipeline, and the PDF a document is
// previewed through is built in that pipeline. So a template had no rendition, `?as=pdf`
// fell through to the raw `.docx`, and every browser saved it to disk. The rendition is now
// built on demand — alone, without dragging templates into OCR, classification or the index.

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

let jar;
let templateId = '';

describe('workstream B1 — a template previews instead of downloading', () => {
  before(async () => {
    await startServer();
    jar = await loginAdmin();
    await api('/api/msgraph/folder', {
      method: 'POST',
      body: { folderId: 'fake-root', folderName: 'fake-onedrive' },
      jar,
    });
    await api('/api/library/sync', { method: 'POST', jar });
    const list = await api('/api/library/list?recursive=1&limit=200', { jar });
    templateId = (list.data.files || []).find((f) => f.path.startsWith('2. Templates'))?.documentId || '';
    assert.ok(templateId, 'the built-in templates were not published to the library');
  });
  after(async () => {
    await stopServer();
  });

  it('serves a PDF for a template that was never ingested', async () => {
    const before = await db();
    const row = before.prepare('SELECT state, text_sha256 FROM documents WHERE document_id = ?').get(templateId);
    before.close();
    assert.equal(row.state, 'listed', 'a template should not be indexed');
    assert.equal(row.text_sha256, '', 'a template should start with no rendition');

    const res = await authedFetch(jar, `/api/library/documents/${templateId}/download?inline=1&as=pdf`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString('latin1'), '%PDF', 'the preview did not receive a PDF');
    assert.match(res.headers.get('content-disposition') || '', /^inline/);
  });

  it('builds the rendition once and reuses it', async () => {
    const d = await db();
    const row = d.prepare('SELECT text_sha256 FROM documents WHERE document_id = ?').get(templateId);
    const cached = d.prepare('SELECT COUNT(*) n FROM renditions').get().n;
    d.close();
    assert.ok(row.text_sha256, 'the rendition was not remembered on the document');
    assert.ok(cached > 0, 'the rendition was not cached by content hash');

    const again = await authedFetch(jar, `/api/library/documents/${templateId}/download?inline=1&as=pdf`);
    assert.equal(again.status, 200);
    const d2 = await db();
    assert.equal(
      d2.prepare('SELECT COUNT(*) n FROM renditions').get().n,
      cached,
      'a second preview converted the template again',
    );
    d2.close();
  });

  it('does not leave a stale preview behind when the template content changes', async () => {
    const d = await db();
    // What an edited template looks like to the app: same row, different content hash.
    d.prepare("UPDATE documents SET sha256 = 'deadbeef' WHERE document_id = ?").run(templateId);
    d.close();

    await api(`/api/library/documents/${templateId}/ingest`, { method: 'POST', jar });

    const d2 = await db();
    const row = d2.prepare('SELECT text_sha256 FROM documents WHERE document_id = ?').get(templateId);
    d2.close();
    assert.equal(row.text_sha256, '', 'the preview still points at the previous edition of the template');
  });

  it('still refuses a PDF for a readable document that has none', async () => {
    const d = await db();
    const now = Date.now();
    d.prepare(
      `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at, sha256)
       VALUES ('doc_noext', 'local-doc_noext', 'sem-pdf.bin', '1. Documentos oficiais Barraqueiro',
               'application/octet-stream', 0, 'listed', 0, ?, ?, ?, '')`,
    ).run(now, now, now);
    d.close();
    await authedFetch(jar, '/api/library/documents/doc_noext/original', {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('not a pdf, not an office file'),
    });
    const res = await authedFetch(jar, '/api/library/documents/doc_noext/download?as=pdf');
    assert.equal(res.status, 409, 'source material with no rendition must still say so');
  });

  it('every editable template knows the library file it was published as', async () => {
    // The editor shows the published document beside the fields being edited, and gets the
    // id from these endpoints. Resolving it by content hash matched four of the six — the
    // published bytes are rendered, not the stored blob — and the other two rendered as
    // "not published yet", which is a lie about a file sitting in the folder.
    const routes = {
      nota_resumo: 'blocks',
      relatorio_revisao: 'blocks',
      email_resumo: 'email',
      email_revisao: 'email',
      dados_resumo: 'fields',
      dados_revisao: 'fields',
    };
    const list = await api('/api/library/list?recursive=1&limit=200', { jar });
    const byId = new Map((list.data.files || []).map((f) => [f.documentId, f]));
    for (const [templateId, route] of Object.entries(routes)) {
      const res = await api(`/api/templates/${templateId}/${route}`, { jar });
      assert.equal(res.data.ok, true, `${templateId}: ${JSON.stringify(res.data)}`);
      const doc = byId.get(res.data.documentId);
      assert.ok(doc, `${templateId} points at no library file (${res.data.documentId || 'empty'})`);
      assert.ok(doc.path.startsWith('2. Templates'), `${templateId} points outside the Templates folder`);
    }
  });

  it('a template row in the library list carries the editor it opens', async () => {
    // The list is where these files are met. Without the id the row can only be previewed or
    // downloaded, and editing means knowing the /templates URL by heart.
    const list = await api('/api/library/list?recursive=1&limit=200', { jar });
    const files = list.data.files || [];
    const templates = files.filter((f) => f.documentKind === 'template');
    assert.ok(templates.length >= 6, `expected the built-in templates, saw ${templates.length}`);
    for (const row of templates) {
      assert.ok(row.templateId, `${row.name} offers no editor`);
    }
    for (const row of files.filter((f) => f.documentKind !== 'template')) {
      assert.equal(row.templateId, '', `${row.name} is not a template but claims an editor`);
    }
  });
});
