import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loadTsModule, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// Phase 13 — the formats the library claims to take.
//
// The library always accepted any file. What it did NOT do was READ most of them: a JPG or
// an .msg was sent to Graph to be "converted to PDF", which Graph does not do for either,
// so the document landed in `failed` and every citation against it died with "página não
// existe". These tests are about the difference between accepting and reading.
//
// The load-bearing assertion is the e-mail attachment one: a PDF inside a message becomes
// its own indexed, citable document with NO AI and NO OneDrive. That is the whole point of
// building the renditions in-process rather than asking a service for them.

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

async function upload(jar, filename, mime, name = filename) {
  const body = new FormData();
  body.append('file', new Blob([readFileSync(path.join(FIXTURES, filename))], { type: mime }), name);
  const res = await fetch(`${BASE}/api/library/upload`, {
    method: 'POST',
    headers: { cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    body,
  });
  return res.json();
}

describe('phase 13 — every accepted format becomes readable (no model calls)', () => {
  let jar;

  before(async () => {
    // No OneDrive at all: not even the fake. Everything below therefore proves the app
    // reads these formats by itself.
    await startServer({ env: { LEGAL_FAKE_GRAPH: '' } });
    jar = await loginAdmin();
  });

  after(async () => {
    await stopServer();
  });

  it('detects by content, not by the name a browser happened to send', async () => {
    const { detectKind } = await loadTsModule('src/lib/server/ingest/detect.ts');
    const head = (file) => readFileSync(path.join(FIXTURES, file)).subarray(0, 4096);

    assert.equal(detectKind(head('nota-interna-transparencia-salarial.pdf'), 'x.bin', ''), 'pdf');
    assert.equal(detectKind(head('foto-contrato.jpg'), 'x.bin', 'application/octet-stream'), 'image_jpeg');
    assert.equal(detectKind(head('captura-ecra.png'), 'x.bin', ''), 'image_png');
    assert.equal(detectKind(head('email-com-anexo.eml'), 'x.bin', ''), 'email_eml');
    // Browsers routinely send application/octet-stream for .msg, so the ROOT CLSID decides.
    assert.equal(detectKind(head('email-outlook.msg'), 'sem-extensao', 'application/octet-stream'), 'email_msg');
    assert.equal(detectKind(readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'documento-word.docx')), 'x', ''), 'office');
    assert.equal(detectKind(head('foto.heic'), 'foto.heic', 'image/heic'), 'unknown');
  });

  it('a photo becomes a one-page PDF the OCR stage can read, EXIF rotation applied', async () => {
    const { imageToPdf } = await loadTsModule('src/lib/server/pdf/image-pdf.ts');
    const jpeg = readFileSync(path.join(FIXTURES, 'foto-contrato.jpg'));
    const { pdf } = imageToPdf(jpeg, 'image_jpeg');

    // The JPEG goes in verbatim: DCTDecode takes its bytes, so the scan is never re-encoded.
    assert.ok(pdf.includes(jpeg), 'the original JPEG must be embedded untouched');
    // Stamped so a test can tell OUR rendition from one a service produced.
    assert.match(pdf.toString('latin1'), /Assistente Juridico - imagem/);

    const { getDocumentProxy } = await import('unpdf');
    const doc = await getDocumentProxy(new Uint8Array(pdf));
    assert.equal(doc.numPages, 1);
    const [, , width, height] = (await doc.getPage(1)).view;
    // The fixture carries EXIF Orientation 6 over a portrait page: applying it must swap
    // the page's sides. Without the rotation this reads portrait, and the OCR pass would
    // transcribe a sideways document.
    assert.ok(width > height, `EXIF orientation must rotate the page (got ${width}x${height})`);
  });

  it('a screenshot with transparency is flattened, not left invisible', async () => {
    const { imageToPdf } = await loadTsModule('src/lib/server/pdf/image-pdf.ts');
    const { getDocumentProxy } = await import('unpdf');
    for (const file of ['captura-ecra.png', 'digitalizacao.png']) {
      const { pdf } = imageToPdf(readFileSync(path.join(FIXTURES, file)), 'image_png');
      const doc = await getDocumentProxy(new Uint8Array(pdf));
      assert.equal(doc.numPages, 1, `${file} must produce one page`);
    }
  });

  it('an image lands indexed with an honest OCR alert instead of failing', async () => {
    const data = await upload(jar, 'foto-contrato.jpg', 'image/jpeg');
    assert.equal(data.ok, true, JSON.stringify(data.indexError));
    assert.equal(data.document.state, 'indexed', data.document.stateDetail);
    assert.equal(data.result.pageCount, 1, 'an image is one page, so citations on page 1 are valid');
    // AI is off in this suite, so the page is honestly marked as awaiting transcription —
    // exactly how a scanned PDF already behaved.
    assert.equal(data.result.ocrPending, 1);
    assert.match(data.document.stateDetail, /Alerta de OCR/i);

    // And the preview serves a real PDF, which is what makes it viewable and citable.
    const pdf = await fetch(`${BASE}/api/library/documents/${data.document.documentId}/download?inline=1&as=pdf`, {
      headers: { cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
    // Stamped by this app's own writer — proof the image never went to Graph, which cannot
    // convert one and whose fake now refuses anything that is not an Office file.
    assert.match(bytes.toString('latin1'), /Assistente Juridico - imagem/);
  });

  it('an e-mail is readable and citable, and its text is the app’s own — never re-read', async () => {
    const data = await upload(jar, 'email-com-anexo.eml', 'message/rfc822');
    assert.equal(data.ok, true, JSON.stringify(data.indexError));
    assert.equal(data.document.state, 'indexed', data.document.stateDetail);

    const detail = await api(`/api/library/documents/${data.document.documentId}`, { jar });
    const page1 = detail.data.pages[0].text;
    assert.match(page1, /De: Joao Silva/);
    assert.match(page1, /Assunto: Revisão do Código de Conduta/, 'RFC2047 subject must be decoded');
    assert.match(page1, /Cc: <direcao@barraqueiro\.pt>/);
    assert.match(page1, /15 dias úteis/, 'quoted-printable body must be decoded');

    // The app wrote this PDF, so it knows the text: no page may be waiting on a vision
    // model to transcribe words the app typed itself.
    assert.equal(
      detail.data.pages.every((p) => !p.pendingOcr),
      true,
      'text the app generated is authoritative and must never be sent to OCR',
    );

    // …and the preview reads it as an E-MAIL, not as a PDF of a text rendering of one. The
    // headers and the attachment list are the reason someone opens an e-mail preview, and
    // they are exactly what a page image loses.
    const parsed = await api(`/api/library/documents/${data.document.documentId}/email`, { jar });
    assert.equal(parsed.data.ok, true, JSON.stringify(parsed.data));
    assert.match(parsed.data.email.subject, /Revisão do Código de Conduta/);
    assert.match(parsed.data.email.from, /Joao Silva/);
    assert.match(parsed.data.email.cc, /direcao@barraqueiro\.pt/);
    assert.match(parsed.data.email.bodyText, /15 dias úteis/);
    const named = parsed.data.email.attachments.filter((a) => !a.inline);
    assert.ok(named.length > 0, 'the attachment is not listed');
    assert.ok(named.every((a) => a.name && a.mime && a.size > 0), 'an attachment without name, type or size');
  });

  it('a PDF inside an e-mail becomes its own citable document — no AI, no OneDrive', async () => {
    const list = await api('/api/library/documents', { jar });
    const attachment = list.data.documents.find((d) => d.name.includes('Nota Interna.pdf'));
    assert.ok(attachment, 'the attachment must be extracted into the library');
    assert.match(attachment.name, /^email-com-anexo — Nota Interna\.pdf$/, 'named after the e-mail it arrived in');
    assert.ok(attachment.parentDocumentId, 'and linked back to that e-mail');

    // The sweep ingests it after the parent's queue slot is released; give it a moment.
    let current = attachment;
    for (let i = 0; i < 100 && current.state !== 'indexed'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const again = await api('/api/library/documents', { jar });
      current = again.data.documents.find((d) => d.documentId === attachment.documentId);
    }
    assert.equal(current.state, 'indexed', current.stateDetail);
    assert.ok(current.pageCount > 1, 'the attached PDF is read as the multi-page document it is');

    const detail = await api(`/api/library/documents/${current.documentId}`, { jar });
    assert.match(detail.data.pages.map((p) => p.text).join(' '), /transparência salarial/i);
  });

  it('re-reading the same e-mail does not create the attachment twice', async () => {
    const before = await api('/api/library/documents', { jar });
    const email = before.data.documents.find((d) => d.name === 'email-com-anexo.eml');
    const countBefore = before.data.documents.filter((d) => d.parentDocumentId === email.documentId).length;
    assert.equal(countBefore, 1);

    const again = await api(`/api/library/documents/${email.documentId}/ingest`, {
      method: 'POST',
      body: { force: true },
      jar,
    });
    assert.equal(again.data.ok, true, JSON.stringify(again.data));

    const after = await api('/api/library/documents', { jar });
    assert.equal(
      after.data.documents.filter((d) => d.parentDocumentId === email.documentId).length,
      1,
      'the attachment id is derived from its content, so a re-read finds the same row',
    );
  });

  it('a .msg it cannot parse fails clearly — never an empty document that looks citable', async () => {
    const data = await upload(jar, 'email-outlook.msg', 'application/octet-stream');
    assert.equal(data.ok, true, 'the file still belongs in the library');
    assert.notEqual(data.document.state, 'indexed');
    assert.match(
      `${data.indexError} ${data.document.stateDetail}`,
      /não foi possível ler este e-mail/i,
      'the reason names the e-mail, not a PDF conversion',
    );
    // The dangerous outcome is a document with one blank page: it passes pageExists and
    // then rejects every citation with a confusing "excerto não encontrado".
    assert.equal(data.document.pageCount, 0);
  });

  it('a format it does not read is kept, and says so in the user’s language', async () => {
    const data = await upload(jar, 'foto.heic', 'image/heic');
    assert.equal(data.ok, true, 'the library still keeps the file');
    const message = `${data.indexError} ${data.document.stateDetail}`;
    assert.match(message, /ainda não é lido pela aplicação/i);
    assert.match(message, /PDF.*Word.*JPG.*PNG/is, 'and names what IS read');
  });

  it('a Word document with no Microsoft 365 says exactly that, and never calls Graph', async () => {
    const body = new FormData();
    const docx = readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'documento-word.docx'));
    body.append('file', new Blob([docx], { type: 'application/octet-stream' }), 'contrato.docx');
    const res = await fetch(`${BASE}/api/library/upload`, {
      method: 'POST',
      headers: { cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      body,
    });
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.match(
      `${data.indexError} ${data.document.stateDetail}`,
      /ligar o Microsoft 365/i,
      'the honest reason, not a 502 about a conversion that was never attempted',
    );
  });
});

describe('phase 13 — the rendition cache cannot go stale (fake Graph)', () => {
  let jar;
  let documentId = '';

  before(async () => {
    await startServer();
    jar = await loginAdmin();
  });

  after(async () => {
    await stopServer();
  });

  it('editing a document re-reads it, instead of serving the previous contents', async () => {
    // The bug this pins down: the rendition used to hang off the DOCUMENT ROW, and the row
    // was consulted before the change check — so an edited file was re-read from the PDF of
    // its own previous contents, silently and forever.
    const first = Buffer.from('Cláusula 4.1 — prazo de denúncia de 30 dias.\n'.repeat(4), 'utf8');
    const second = Buffer.from('Cláusula 4.1 — prazo de denúncia de 60 dias.\n'.repeat(4), 'utf8');

    const upload1 = new FormData();
    upload1.append('file', new Blob([first], { type: 'text/plain' }), 'clausula.txt');
    const created = await fetch(`${BASE}/api/library/upload`, {
      method: 'POST',
      headers: { cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: upload1,
    }).then((r) => r.json());
    documentId = created.document.documentId;

    const before = await api(`/api/library/documents/${documentId}`, { jar });
    assert.match(before.data.pages.map((p) => p.text).join(''), /30 dias/);

    // Re-stage different bytes under the same document, as a changed OneDrive file would.
    await fetch(`${BASE}/api/library/documents/${documentId}/original`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: second,
    });
    await api(`/api/library/documents/${documentId}/ingest`, { method: 'POST', body: { force: true }, jar });

    const after = await api(`/api/library/documents/${documentId}`, { jar });
    const text = after.data.pages.map((p) => p.text).join('');
    assert.match(text, /60 dias/, 'the new contents must be what is read');
    assert.doesNotMatch(text, /30 dias/, 'and the previous rendition must not survive the edit');
  });

  it('the app publishes its own templates and creates the folder structure by itself', async () => {
    // No button does this. Choosing the library folder builds the structure, and so does
    // every sync after it — which is what makes a library that lost its folders, or moved
    // to another account, repair itself.
    const created = await api('/api/msgraph/folder', {
      method: 'POST',
      body: { folderId: 'fake-root', folderName: 'fake-onedrive' },
      jar,
    });
    assert.equal(created.data.ok, true, JSON.stringify(created.data));

    const drive = path.join(testDataDir(), 'fake-onedrive');
    for (const folder of ['1. Documentos oficiais Barraqueiro', '2. Templates', '3. Resultados']) {
      assert.ok(existsSync(path.join(drive, folder)), `${folder} must exist`);
    }
    assert.ok(existsSync(path.join(drive, '2. Templates', 'Resumo documental', 'nota-resumo.docx')));

    // Idempotent: a second call must not leave "nota-resumo 1.docx" behind.
    const again = await api('/api/library/sync', { method: 'POST', jar });
    assert.equal(again.data.ok, true, JSON.stringify(again.data));
    const published = readdirSync(path.join(drive, '2. Templates', 'Resumo documental')).sort();
    // A workflow has one template per KIND: the Word document, the e-mail that sends it,
    // and the field list the agent extracts to.
    assert.deepEqual(published, ['dados-resumo.json', 'email-resumo.eml', 'nota-resumo.docx']);

    // And the published built-ins must not become duplicate registry entries.
    const templates = await api('/api/templates', { jar });
    const active = templates.data.templates.filter((t) => t.active);
    assert.equal(active.length, 6, JSON.stringify(active.map((t) => t.templateId)));
    assert.equal(active.every((t) => t.source === 'builtin'), true);
  });

  it('an upload with no folder lands in the client’s own documents folder', async () => {
    const body = new FormData();
    body.append('file', new Blob([readFileSync(path.join(FIXTURES, 'captura-ecra.png'))], { type: 'image/png' }), 'nota.png');
    const data = await fetch(`${BASE}/api/library/upload`, {
      method: 'POST',
      headers: { cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      body,
    }).then((r) => r.json());
    assert.equal(data.ok, true);
    // Where the app records it — the OneDrive copy only happens once a library folder has
    // been chosen, which the structure test above covers.
    assert.equal(data.document.path, '1. Documentos oficiais Barraqueiro');
  });
});

describe('phase 13 — the library layout is decided in one place', () => {
  it('recognises this app’s outputs under both the new and the legacy folder', async () => {
    const layout = await loadTsModule('src/lib/library-layout.ts');
    assert.equal(layout.isGeneratedOutput('3. Documentos gerados/Resumo documental/X/a.pdf'), true);
    assert.equal(layout.isGeneratedOutput('Documentos gerados (Assistente Jurídico)/X/a.pdf'), true);
    // Segment-aware: a client folder whose name merely STARTS the same way is theirs.
    assert.equal(layout.isGeneratedOutput('3. Documentos gerados antigos/a.pdf'), false);
    assert.equal(layout.isTemplateFolder('2. Templates/Resumo documental/m.docx'), true);
    assert.equal(layout.isOfficialDocument('Contratos/2024/a.pdf'), true);

    // A slash in a folder name would silently become two folders — and the revision
    // workflow's own label ("Revisão / Atualização") contains one.
    for (const name of [...Object.values(layout.LIBRARY_FOLDERS), ...Object.values(layout.ANALYSIS_FOLDER_NAMES)]) {
      assert.equal(name.includes('/'), false, `"${name}" must not contain a path separator`);
    }
  });

  // The companion test — "files that predate the reorganisation are browsed under the
  // client's folder" — went with `displayPath` in phase 5. Those files are no longer
  // *shown* somewhere they are not; they are moved there, and phase14-migration proves it.
});
