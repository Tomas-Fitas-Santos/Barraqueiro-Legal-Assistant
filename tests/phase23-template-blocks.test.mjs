import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// Workstream B2 — a template is a BLOCK LIST, and the .docx is a product of it.
//
// The templates were composed from a handful of block shapes in a build script, so the only
// thing the app held was the file that came out. Editing meant editing Word XML, where the
// placeholders that make a template a template are indistinguishable from prose. Holding the
// blocks makes add/remove/reorder ordinary, and makes a lost placeholder something the app
// can see and name.

const publishedTemplate = (file = 'nota-resumo.docx', folder = 'Resumo documental') =>
  path.join(testDataDir(), 'fake-onedrive', '2. Templates', folder, file);

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

async function headerXmlOf(bytes) {
  const { default: PizZip } = await import('pizzip');
  const header = new PizZip(Buffer.from(bytes)).file('word/header1.xml');
  return header ? header.asText() : '';
}

async function documentXmlOf(bytes) {
  const { default: PizZip } = await import('pizzip');
  return new PizZip(Buffer.from(bytes)).file('word/document.xml').asText();
}

let jar;

describe('workstream B2 — templates are edited as blocks', () => {
  before(async () => {
    await startServer();
    jar = await loginAdmin();
    await api('/api/msgraph/folder', {
      method: 'POST',
      body: { folderId: 'fake-root', folderName: 'fake-onedrive' },
      jar,
    });
    await api('/api/library/sync', { method: 'POST', jar });
  });
  after(async () => {
    await stopServer();
  });

  it('renders the same template twice from the same blocks', async () => {
    // Determinism is not tidiness: the registry versions a template by the hash of its
    // rendering, so bytes that drift on their own would mint a version on every boot. The
    // build script this replaced stamped each zip entry with the wall clock.
    const first = readFileSync(publishedTemplate());
    await api('/api/library/sync', { method: 'POST', jar });
    assert.equal(readFileSync(publishedTemplate()).equals(first), true, 'the same blocks rendered different bytes');

    const d = await db();
    const versions = d.prepare("SELECT COUNT(*) n FROM templates WHERE template_id = 'nota_resumo'").get().n;
    d.close();
    assert.equal(versions, 1, 'an unchanged template registered a second version');
  });

  it('exposes the blocks a template is made of', async () => {
    const res = await api('/api/templates/nota_resumo/blocks', { jar });
    assert.equal(res.data.edited, false);
    const kinds = res.data.blocks.map((b) => b.type);
    assert.deepEqual(kinds, ['paragraph', 'paragraph', 'paragraph', 'paragraph', 'loop', 'paragraph', 'table', 'paragraph']);
    // The placeholders are properties of blocks, not text to be hunted for.
    for (const field of res.data.requiredFields) {
      assert.ok(res.data.placeholders.includes(field), `${field} is not offered by the template`);
    }
  });

  it('an edit re-renders the file, mints a version and reaches the library', async () => {
    const before = readFileSync(publishedTemplate());
    const blocks = (await api('/api/templates/nota_resumo/blocks', { jar })).data.blocks;
    blocks[0] = { type: 'paragraph', text: 'GRUPO BARRAQUEIRO — CONFIDENCIAL', style: 'Small' };
    blocks.push({ type: 'paragraph', text: 'Documento interno.', style: 'Small' });

    const res = await api('/api/templates/nota_resumo/blocks', { method: 'PUT', body: { blocks }, jar });
    assert.equal(res.data.ok, true);

    const after = readFileSync(publishedTemplate());
    assert.equal(after.equals(before), false, 'the edited template never reached the library');
    const xml = await documentXmlOf(after);
    assert.match(xml, /GRUPO BARRAQUEIRO — CONFIDENCIAL/);
    assert.match(xml, /Documento interno\./);

    const d = await db();
    const rows = d
      .prepare("SELECT version, active, file_sha256 FROM templates WHERE template_id = 'nota_resumo' ORDER BY version")
      .all();
    d.close();
    assert.equal(rows.length, 2, 'the edit did not mint a new version');
    assert.equal(rows[1].active, 1);
    assert.equal(rows[1].file_sha256, createHash('sha256').update(after).digest('hex'));

    assert.equal((await api('/api/templates/nota_resumo/blocks', { jar })).data.edited, true);
  });

  it('refuses to drop a required placeholder without saying so', async () => {
    const blocks = (await api('/api/templates/nota_resumo/blocks', { jar })).data.blocks;
    // Removing the sections loop is exactly the change that produces a document with no body
    // and no visible sign anything is wrong.
    const without = blocks.filter((b) => b.type !== 'loop');

    const res = await authedFetch(jar, '/api/templates/nota_resumo/blocks', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blocks: without }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.needsConfirmation, true);
    assert.deepEqual(body.missing, ['sections']);

    // Named and confirmed, it goes through — the client may genuinely want it gone.
    const confirmed = await api('/api/templates/nota_resumo/blocks', {
      method: 'PUT',
      body: { blocks: without, confirm: true },
      jar,
    });
    assert.equal(confirmed.data.ok, true);
    assert.ok(!(await documentXmlOf(readFileSync(publishedTemplate()))).includes('{#sections}'));
  });

  it('puts the app’s own template back', async () => {
    const res = await authedFetch(jar, '/api/templates/nota_resumo/blocks', { method: 'DELETE' });
    assert.equal(res.status, 200);
    const state = await api('/api/templates/nota_resumo/blocks', { jar });
    assert.equal(state.data.edited, false);
    const xml = await documentXmlOf(readFileSync(publishedTemplate()));
    assert.match(xml, /\{#sections\}/, 'reverting did not restore the sections loop');
    assert.ok(!xml.includes('CONFIDENCIAL'), 'reverting left the edit behind');
  });

  it('fits a replacement logo inside the same box, without stretching it', async () => {
    const shown = await api('/api/templates/logo', { jar });
    assert.equal(shown.data.logo.isDefault, true);
    // 25.4 mm wide is the reference measurement; the default mark is slightly taller than wide.
    assert.deepEqual(shown.data.logo.boxMm, { w: 25.4, h: 24 });
    assert.deepEqual(shown.data.logo.printedMm, { w: 25.4, h: 24 });

    // A WIDE mark: it takes the full width of the box and less than its height.
    const wide = readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'captura-ecra.png'));
    const res = await authedFetch(jar, '/api/templates/logo', { method: 'POST', body: wide });
    const body = await res.json();
    assert.equal(body.ok, true);
    const { printedMm, boxMm, px } = body.logo;
    assert.ok(printedMm.w <= boxMm.w + 0.05 && printedMm.h <= boxMm.h + 0.05, 'the logo overflows its box');
    assert.ok(
      Math.abs(printedMm.w - boxMm.w) < 0.05 || Math.abs(printedMm.h - boxMm.h) < 0.05,
      'the logo does not touch either edge of the box — it was not scaled to fit',
    );
    // Scaled as a whole: the printed shape keeps the image's own proportions.
    assert.ok(Math.abs(printedMm.w / printedMm.h - px.w / px.h) < 0.02, 'the logo was stretched');

    const xml = await headerXmlOf(readFileSync(publishedTemplate()));
    assert.match(xml, new RegExp(`cx="${Math.round(printedMm.w * 36000)}"`.replace(/([.*+?^${}()|[\]\\])/g, '\\$1')));

    // And it is the client's image that is embedded, not the old one.
    const { default: PizZip } = await import('pizzip');
    const zip = new PizZip(readFileSync(publishedTemplate()));
    assert.ok(zip.file('word/media/logotipo.png'), 'the new mark was not embedded');
  });

  it('rejects a file that is not an image, and restores the original mark', async () => {
    const notAnImage = await authedFetch(jar, '/api/templates/logo', {
      method: 'POST',
      body: Buffer.from('this is not a picture'),
    });
    assert.equal(notAnImage.status, 400);

    const reset = await authedFetch(jar, '/api/templates/logo', { method: 'DELETE' });
    assert.equal((await reset.json()).logo.isDefault, true);
    const { default: PizZip } = await import('pizzip');
    assert.ok(new PizZip(readFileSync(publishedTemplate())).file('word/media/logotipo.jpeg'));
  });

  it('offers the editor from the template’s own library page', async () => {
    const list = await api('/api/library/list?recursive=1&limit=200', { jar });
    const tpl = (list.data.files || []).find((f) => f.name === 'nota-resumo.docx');
    assert.ok(tpl, 'the built-in template is not in the library');
    const detail = await api(`/api/library/documents/${tpl.documentId}`, { jar });
    assert.equal(detail.data.editableTemplateId, 'nota_resumo');

    // Source material is not a template and must not offer to be edited as one.
    const source = (list.data.files || []).find((f) => f.path.startsWith('1. Documentos oficiais'));
    if (source) {
      const other = await api(`/api/library/documents/${source.documentId}`, { jar });
      assert.equal(other.data.editableTemplateId, '');
    }
  });

  it('leaves a client-supplied template alone', async () => {
    // Only the app's own templates are block lists. A .docx the client wrote in Word is
    // registered and filled, but there is nothing here to edit it with.
    const res = await authedFetch(jar, '/api/templates/lib_summary_qualquer/blocks');
    assert.equal(res.status, 404);
    writeFileSync(publishedTemplate('cliente.docx'), readFileSync(publishedTemplate()));
  });
});
