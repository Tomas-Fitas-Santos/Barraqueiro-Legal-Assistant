import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// The template editors preview what is being EDITED, not what was last published.
//
// Before this, the only way to see the effect of a change was `Guardar e publicar`, which
// mints a template version and replaces the copy on the client's OneDrive. Looking cost a
// version on a live client drive, so the feedback loop ran through the client's data.
//
// Two properties make the draft preview trustworthy, and both are asserted here: it writes
// NOTHING, and its bytes are the bytes a save would publish. The second is the one that
// matters — a preview that renders by a different path than the publisher is a preview that
// can lie about what you are about to send.

const publishedTemplate = (file = 'nota-resumo.docx', folder = 'Resumo documental') =>
  path.join(testDataDir(), 'fake-onedrive', '2. Templates', folder, file);

async function authedFetch(jar, p, init = {}) {
  return fetch(`${BASE}${p}`, {
    ...init,
    headers: { ...(init.headers || {}), cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
}

const sha = (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex');

describe('template draft preview', () => {
  let jar;

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

  it('renders the blocks it is given without saving or publishing them', async () => {
    const before = (await api('/api/templates/nota_resumo/blocks', { jar })).data;
    assert.equal(before.edited, false);

    const publishedPath = publishedTemplate();
    const publishedBefore = readFileSync(publishedPath);
    const mtimeBefore = statSync(publishedPath).mtimeMs;

    const changed = [
      { type: 'paragraph', text: 'UM CABEÇALHO QUE NUNCA FOI GUARDADO', style: 'Small' },
      ...before.blocks.slice(1),
    ];
    const res = await authedFetch(jar, '/api/templates/nota_resumo/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blocks: changed }),
    });
    assert.equal(res.status, 200);
    const drawn = Buffer.from(await res.arrayBuffer());
    // It really did render the draft, not the stored template.
    assert.equal(drawn.subarray(0, 4).toString('binary'), 'PK\x03\x04');
    assert.notEqual(sha(drawn), sha(publishedBefore));

    // …and nothing moved: not the stored blocks, not the published file.
    const after = (await api('/api/templates/nota_resumo/blocks', { jar })).data;
    assert.equal(after.edited, false);
    assert.deepEqual(after.blocks, before.blocks);
    assert.equal(sha(readFileSync(publishedPath)), sha(publishedBefore));
    assert.equal(statSync(publishedPath).mtimeMs, mtimeBefore);
  });

  it('previews the bytes a save would publish', async () => {
    const { blocks } = (await api('/api/templates/nota_resumo/blocks', { jar })).data;
    const edited = [{ type: 'paragraph', text: 'GRUPO BARRAQUEIRO — REVISTO', style: 'Small' }, ...blocks.slice(1)];

    const previewed = Buffer.from(
      await (
        await authedFetch(jar, '/api/templates/nota_resumo/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ blocks: edited }),
        })
      ).arrayBuffer(),
    );

    const saved = await api('/api/templates/nota_resumo/blocks', { method: 'PUT', body: { blocks: edited }, jar });
    assert.equal(saved.data.ok, true);

    // The published file must be byte-identical to what was previewed a moment earlier.
    assert.equal(sha(readFileSync(publishedTemplate())), sha(previewed));

    await authedFetch(jar, '/api/templates/nota_resumo/blocks', { method: 'DELETE' });
  });

  it('draws a draft that drops a required placeholder, and still refuses to save it', async () => {
    const { blocks, requiredFields } = (await api('/api/templates/nota_resumo/blocks', { jar })).data;
    assert.ok(requiredFields.includes('doc_title'));
    const without = blocks.filter((b) => !(b.type === 'paragraph' && b.text.includes('{doc_title}')));

    // Drawing it is allowed: seeing the consequence is the whole point of looking before
    // deciding. A preview that refused would hide the change being considered.
    const preview = await authedFetch(jar, '/api/templates/nota_resumo/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blocks: without }),
    });
    assert.equal(preview.status, 200);

    // Making it permanent still needs the loss named and confirmed.
    const save = await authedFetch(jar, '/api/templates/nota_resumo/blocks', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blocks: without }),
    });
    assert.equal(save.status, 409);
    assert.deepEqual((await save.json()).missing, ['doc_title']);
  });

  it('parses an e-mail draft back through the ingest parser', async () => {
    const res = await authedFetch(jar, '/api/templates/email_resumo/email/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'Assunto de teste — acentuação', body: 'Olá,\n\nSegue o documento.' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    // Round-tripped through the base64 subject header and back out again: if the .eml were
    // malformed the parser would not return the accents intact.
    assert.equal(data.email.subject, 'Assunto de teste — acentuação');
    assert.match(data.email.bodyText, /Segue o documento\./);

    const stored = (await api('/api/templates/email_resumo/email', { jar })).data;
    assert.equal(stored.edited, false);
    assert.notEqual(stored.subject, 'Assunto de teste — acentuação');
  });

  it('refuses an extraction draft that would break the citation spine', async () => {
    const { fields } = (await api('/api/templates/dados_resumo/fields', { jar })).data;
    const ok = await authedFetch(jar, '/api/templates/dados_resumo/fields/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    assert.equal(ok.status, 200);
    const specimen = JSON.parse(await ok.text());
    assert.equal(specimen.schema, 'legal-assistant/extraction-template@1');

    const broken = await authedFetch(jar, '/api/templates/dados_resumo/fields/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields: [{ key: 'source_excerpt', label: 'x', description: 'y' }] }),
    });
    assert.equal(broken.ok, false);
  });
});
