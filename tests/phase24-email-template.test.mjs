import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// Workstream C — the e-mail is a template too (ClickUp issue 3).
//
// The draft's subject and body were written in the code that builds it, so changing a
// greeting meant a deploy. They are now a registered template per workflow, published beside
// the Word one as a real `.eml` the client can open, and the draft fills it.

const templateFile = (file, folder = 'Resumo documental') =>
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

let jar;

describe('workstream C — the e-mail that delivers the document is a template', () => {
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

  it('registers one e-mail template per workflow, beside the Word one', async () => {
    const rows = (await api('/api/templates', { jar })).data.templates.filter((t) => t.active);
    const emails = rows.filter((t) => t.kind === 'eml');
    assert.deepEqual(
      emails.map((t) => t.templateId).sort(),
      ['email_resumo', 'email_revisao'],
      'the workflows do not each have an e-mail template',
    );
    assert.deepEqual(emails.map((t) => t.analysisType).sort(), ['revision', 'summary']);
    // Both kinds live in the same registry and version the same way.
    for (const row of emails) assert.equal(row.version, 1);
  });

  it('publishes it as a real .eml the client can open', async () => {
    const bytes = readFileSync(templateFile('email-resumo.eml'));
    const text = bytes.toString('utf8');
    assert.match(text, /^Subject: =\?UTF-8\?B\?/m, 'the subject is not an RFC 2047 encoded word');
    assert.match(text, /^X-Unsent: 1$/m, 'a stencil should open as a draft, not as received mail');
    assert.match(text, /Exmos\. Senhores,/);
    // The placeholders are still in it — this is the stencil, not a filled message.
    assert.match(text, /\{version\}/);
    assert.ok(readFileSync(templateFile('email-revisao.eml', 'Revisão e Atualização')).length > 0);
  });

  it('does not offer the e-mail template as a format for the Word document', async () => {
    // Both kinds share a registry, so the document selector has to say which it wants.
    const rows = (await api('/api/templates', { jar })).data.templates;
    const docx = rows.filter((t) => t.active && t.kind === 'docx').map((t) => t.templateId);
    assert.ok(docx.includes('nota_resumo'));
    assert.ok(!docx.includes('email_resumo'));
  });

  it('an edit re-renders the .eml, mints a version and reaches the library', async () => {
    const before = readFileSync(templateFile('email-resumo.eml')).toString('utf8');
    const res = await api('/api/templates/email_resumo/email', {
      method: 'PUT',
      body: { subject: 'Envio de {analysis_type}', body: 'Caros,\n\nSegue {main_document} ({version}).' },
      jar,
    });
    assert.equal(res.data.ok, true);

    const after = readFileSync(templateFile('email-resumo.eml')).toString('utf8');
    assert.notEqual(after, before, 'the edited e-mail template never reached the library');
    assert.match(after, /Caros,/);

    const d = await db();
    const versions = d.prepare("SELECT COUNT(*) n FROM templates WHERE template_id = 'email_resumo'").get().n;
    d.close();
    assert.equal(versions, 2, 'the edit did not mint a new version');

    assert.equal((await api('/api/templates/email_resumo/email', { jar })).data.edited, true);
  });

  it('refuses an empty subject', async () => {
    const res = await authedFetch(jar, '/api/templates/email_resumo/email', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: '   ', body: 'x' }),
    });
    assert.equal(res.status, 400);
  });

  it('puts the app’s own wording back', async () => {
    const res = await authedFetch(jar, '/api/templates/email_resumo/email', { method: 'DELETE' });
    assert.equal(res.status, 200);
    const state = await api('/api/templates/email_resumo/email', { jar });
    assert.equal(state.data.edited, false);
    assert.match(state.data.subject, /\{analysis_type\}/);
  });

  it('offers the editor from the .eml’s own library page', async () => {
    const list = await api('/api/library/list?recursive=1&limit=200', { jar });
    const eml = (list.data.files || []).find((f) => f.name === 'email-resumo.eml');
    assert.ok(eml, 'the e-mail template is not in the library');
    const detail = await api(`/api/library/documents/${eml.documentId}`, { jar });
    assert.equal(detail.data.editableTemplateId, 'email_resumo');
  });

  it('lists what is attached, with size and type, instead of one crowded line', async () => {
    const { loadTsModule } = await import('./helpers.mjs');
    const email = await loadTsModule('src/lib/server/ingest/email.ts');
    const rendered = email.renderEmailText({
      from: 'a@b.pt',
      to: 'c@d.pt',
      cc: '',
      date: '',
      subject: 'Assunto',
      messageId: '',
      bodyText: 'Corpo da mensagem.',
      attachments: [
        { filename: 'relatorio.pdf', mimeType: 'application/pdf', bytes: Buffer.alloc(2048), inline: false, contentId: '' },
        { filename: 'logo.png', mimeType: 'image/png', bytes: Buffer.alloc(10), inline: true, contentId: 'cid1' },
      ],
    });
    assert.match(rendered, /Anexos \(1\)/, 'the inline signature logo was counted as an attachment');
    assert.match(rendered, /relatorio\.pdf — application\/pdf, 2 kB/);
    assert.match(rendered, /1 imagem\(ns\) incorporada\(s\)/);
    // The crowded header line is gone.
    assert.ok(!/^Anexos: /m.test(rendered));
  });
});
