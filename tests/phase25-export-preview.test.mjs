import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loadTsModule, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// Workstream D1/D2 — the extraction JSON is a document too.
//
// It is written to OneDrive beside the DOCX and the PDF at conversion time, and then sat
// there unopenable: an app-managed file, never ingested, no rendition, no preview. It is the
// only place the app records WHY each statement was refused, so "machine-readable" had come
// to mean "unreadable".

const EXPORT = {
  schema: 'legal-assistant/analysis-export@1',
  generatedAt: 1756600000000,
  analysis: { analysisId: 'an_1', type: 'summary', typeLabel: 'Resumo documental', state: 'concluida', instructions: 'Focar nos prazos.', closedAt: null, createdAt: 1756500000000 },
  mainDocument: { documentId: 'doc_1', name: 'Código de Conduta.pdf' },
  relatedDocuments: [{ documentId: 'doc_2', name: 'PPRC.pdf', relationType: 'complementa', status: 'confirmed' }],
  template: { templateId: 'nota_resumo', version: 3, name: 'Nota informativa / Resumo', source: 'builtin' },
  extraction: { extractionId: 'ex_1', label: 'E1', pathLetter: 'A', origin: 'ai', acceptedCount: 1, rejectedCount: 1, approvedAt: 1756550000000, approvedBy: 'tomas@naten.ai', note: '' },
  items: [
    {
      itemId: 'it_1', seq: 1, kind: 'statement', accepted: true, rejectionReason: '', decision: 'accepted',
      payload: {
        topic: 'Denúncias', content: 'O canal de denúncias funciona em permanência.', scope: 'Todo o Grupo',
        entity: 'Colaboradores', required_action: 'Manter o canal disponível', suggested_owner: 'Compliance',
        deadline: '30 dias', consequence: 'Processo disciplinar', exceptions: '',
        source_page: 4, source_version: 'v2', source_excerpt: 'O canal funciona em permanência.',
        evidence_quality: 'direct', ai_suggestion: false,
      },
    },
    {
      itemId: 'it_2', seq: 2, kind: 'statement', accepted: false, rejectionReason: 'Excerto não encontrado na página citada.', decision: 'rejected',
      payload: { topic: 'Formação', content: 'Formação anual obrigatória.', source_page: 9, evidence_quality: 'not_confirmed', ai_suggestion: true },
    },
  ],
  references: [{ n: 1, documentId: 'doc_1', document: 'Código de Conduta', version: 'v2', page: 4, excerpt: 'O canal funciona em permanência.' }],
  version: { versionId: 'v_1', label: 'v1', filename: 'Resumo.docx', origin: 'ai', sha256: 'abc', templateId: 'nota_resumo', templateVersion: 3, createdAt: 1756590000000 },
  outputs: { docx: 'Resumo.docx', pdf: 'Resumo.pdf', json: 'Resumo_dados.json' },
};

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
let jsonId = '';

describe('workstream D1/D2 — the extraction JSON reads as a document', () => {
  before(async () => {
    await startServer();
    jar = await loginAdmin();
    await api('/api/msgraph/folder', {
      method: 'POST',
      body: { folderId: 'fake-root', folderName: 'fake-onedrive' },
      jar,
    });
    await api('/api/library/sync', { method: 'POST', jar });
    // A generated export, where conversions.ts writes one.
    const folder = path.join(testDataDir(), 'fake-onedrive', '3. Resultados', 'Resumo documental');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'Resumo_dados.json'), JSON.stringify(EXPORT, null, 2), 'utf8');
    await api('/api/library/sync', { method: 'POST', jar });
    const list = await api('/api/library/list?recursive=1&limit=200', { jar });
    jsonId = (list.data.files || []).find((f) => f.name === 'Resumo_dados.json')?.documentId || '';
    assert.ok(jsonId, 'the export never reached the library');
  });
  after(async () => {
    await stopServer();
  });

  it('is a JSON, not "a text file that happens to parse"', async () => {
    const detect = await loadTsModule('src/lib/server/ingest/detect.ts');
    assert.equal(detect.detectKind(Buffer.from('{"a":1}'), 'dados.json'), 'json');
    assert.equal(detect.detectKind(Buffer.from('{"a":1}'), 'x', 'application/json'), 'json');
    // A .txt is still printed, not rendered.
    assert.equal(detect.detectKind(Buffer.from('ola'), 'nota.txt'), 'text');
  });

  it('lays the extraction out the way the review screen does', async () => {
    const render = await loadTsModule('src/lib/server/ingest/render-export.ts');
    assert.equal(render.isAnalysisExport(EXPORT), true);
    assert.equal(render.isAnalysisExport({ schema: 'algo/outro@1' }), false);
    const text = render.renderAnalysisExportText(EXPORT);

    assert.match(text, /Resumo documental — dados extraídos/);
    assert.match(text, /Documento principal: Código de Conduta\.pdf/);
    // Every user-facing enum in the client's language — no raw `confirmed` in a document
    // the client reads.
    assert.match(text, /PPRC\.pdf — complementa, confirmada/);
    assert.ok(!text.includes('confirmed'), 'a raw English enum leaked into the rendered view');
    // The client's own field labels, not the JSON keys.
    assert.match(text, /Medidas a implementar: Manter o canal disponível/);
    assert.ok(!text.includes('required_action'), 'a raw schema key leaked into the rendered view');
    // Confidence derived from the evidence, in the client's vocabulary.
    assert.match(text, /Confiança alta/);
    assert.match(text, /Não confirmada/);
    // The refusals are a section of their own, with their reason — this file is the only
    // readable record of what the app declined to assert.
    assert.match(text, /Conteúdo aceite \(1\)/);
    assert.match(text, /Conteúdo rejeitado \(1\)/);
    assert.match(text, /Motivo da rejeição: Excerto não encontrado na página citada\./);
    assert.match(text, /\[1\] Código de Conduta v2 — página 4/);
    assert.match(text, /\[sugestão da IA\]/);
    // A citation with no version and no excerpt says what it knows, not "— — “—”".
    assert.match(text, /Fonte: página 9\n/);
  });

  it('prints the punctuation real prose is made of', async () => {
    // The content stream is written as latin1, so declaring WinAnsiEncoding was not enough:
    // an em dash and a curly quote were truncated to "?" and € came out as "¬". Every e-mail
    // preview and every rendered export was pockmarked with them.
    const { textToPdf } = await loadTsModule('src/lib/server/pdf/text-pdf.ts');
    const out = textToPdf('Prazo — 30 dias, “conforme” o Código, 5 €.');
    assert.equal(out.note, '', 'representable punctuation was reported as unrepresentable');
    const stream = out.pdf.toString('latin1');
    assert.ok(stream.includes(String.fromCharCode(0x97)), 'the em dash did not survive');
    assert.ok(stream.includes(String.fromCharCode(0x93)), 'the opening curly quote did not survive');
    assert.ok(stream.includes(String.fromCharCode(0x80)), 'the euro sign did not survive');
    // Something genuinely outside the encoding is still replaced AND reported.
    assert.match(textToPdf('emoji \u{1F600}').note, /não são representáveis/);
  });

  it('previews as a PDF instead of downloading', async () => {
    const res = await authedFetch(jar, `/api/library/documents/${jsonId}/download?inline=1&as=pdf`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString('latin1'), '%PDF');
    assert.match(res.headers.get('content-disposition') || '', /^inline/);
  });

  it('shows the raw JSON as its text view, not the rendered one', async () => {
    const detail = await api(`/api/library/documents/${jsonId}`, { jar });
    const text = (detail.data.pages || []).map((p) => p.text).join('\n');
    assert.ok(text.trim(), 'the export has no text view');
    // The text view is the bytes, because being the machine-readable record IS the point.
    assert.match(text, /"schema"/);
    assert.match(text, /legal-assistant\/analysis-export@1/);
    assert.ok(!text.includes('Conteúdo rejeitado'), 'the text view showed the rendering instead of the file');
  });

  it('never becomes a page a citation can rest on', async () => {
    // Readable and citable are different permissions: the preview text comes from the
    // rendition cache, so the app can never cite its own output back at itself.
    const d = await db();
    const pages = d.prepare('SELECT COUNT(*) n FROM document_pages WHERE document_id = ?').get(jsonId).n;
    const state = d.prepare('SELECT state FROM documents WHERE document_id = ?').get(jsonId).state;
    d.close();
    assert.equal(pages, 0, 'the generated export was indexed as citable ground truth');
    assert.equal(state, 'listed');
  });

  it('refuses a .json that is not JSON, in a sentence', async () => {
    const folder = path.join(testDataDir(), 'fake-onedrive', '3. Resultados', 'Resumo documental');
    writeFileSync(path.join(folder, 'partido.json'), '{ isto não é json', 'utf8');
    await api('/api/library/sync', { method: 'POST', jar });
    const list = await api('/api/library/list?recursive=1&limit=200', { jar });
    const brokenId = (list.data.files || []).find((f) => f.name === 'partido.json')?.documentId;
    assert.ok(brokenId);
    const res = await authedFetch(jar, `/api/library/documents/${brokenId}/download?inline=1&as=pdf`);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /não é JSON válido/);
  });
});
