import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loginAdmin, startServer, stopServer, testDataDir, seedExtraction } from './helpers.mjs';

// Phase 5 — the document workspace, without any model call: the deterministic fallback
// narrative makes the whole DOCX chain testable (generation, Anexo de fontes, version
// immutability, single-final invariant, manual uploads, template registry).

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

async function db() {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
}

async function readDocxText(bytes) {
  const { default: PizZip } = await import('pizzip');
  const zip = new PizZip(Buffer.from(bytes));
  return zip.file('word/document.xml').asText();
}

async function fetchBytes(jar, p) {
  const res = await fetch(`${BASE}${p}`, {
    headers: { cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

let analysisId = '';

describe('phase 5 — document in preparation (no model calls)', () => {
  before(async () => {
    await startServer();
    const jar = await loginAdmin();
    // An indexed main document + a summary analysis with validated items, seeded to the
    // exact state a completed run leaves behind.
    const bytes = readFileSync(path.join(FIXTURES, 'nota-interna-transparencia-salarial.pdf'));
    const d0 = await db();
    const now = Date.now();
    d0.prepare(
      `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
       VALUES ('doc_main', 'local-doc_main', 'Nota Interna.pdf', '', 'application/pdf', 0, 'listed', 0, ?, ?, ?)`,
    ).run(now, now, now);
    d0.close();
    await fetch(`${BASE}/api/library/documents/doc_main/original`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: bytes,
    });

    const created = await api('/api/analyses', {
      method: 'POST',
      body: { type: 'summary', mainDocumentId: 'doc_main' },
      jar,
    });
    analysisId = created.data.analysis.analysisId;

    const d = await db();
    d.prepare(`UPDATE analyses SET state = 'pronta_para_revisao' WHERE analysis_id = ?`).run(analysisId);
    const extractionId = seedExtraction(d, analysisId, `ext_${analysisId.slice(-8)}`);
    const item = (seq, payload, accepted = 1, decision = 'pending') =>
      d.prepare(
        `INSERT INTO analysis_items (item_id, analysis_id, extraction_id, seq, kind, payload_json, accepted, decision, created_at)
         VALUES (?, ?, ?, ?, 'statement', ?, ?, ?, ?)`,
      ).run(`itm_p5_${seq}`, analysisId, extractionId, seq, JSON.stringify(payload), accepted, decision, now);
    item(0, {
      statement_type: 'obligation',
      content: 'Garantir a igualdade salarial entre homens e mulheres.',
      source_document_id: 'doc_main', source_version: '', source_page: 1,
      source_excerpt: 'trabalho igual salário igual', evidence_quality: 'direct', ai_suggestion: false,
    });
    item(1, {
      statement_type: 'deadline',
      content: 'Comunicar as tabelas salariais até 30 de abril.',
      source_document_id: 'doc_main', source_version: '', source_page: 2,
      source_excerpt: 'até 30 de abril', evidence_quality: 'direct', ai_suggestion: false,
    });
    // User-rejected: must NOT appear in any generated document.
    item(2, {
      statement_type: 'other',
      content: 'CONTEUDO-REJEITADO-PELO-UTILIZADOR',
      source_document_id: 'doc_main', source_version: '', source_page: 3,
      source_excerpt: 'x', evidence_quality: 'direct', ai_suggestion: false,
    }, 1, 'rejected');
    d.close();
  });
  after(async () => {
    await stopServer();
  });

  it('template registry seeded with the briefing templates at v1, idempotently', async () => {
    const jar = await loginAdmin();
    const res = await api('/api/templates', { jar });
    const active = res.data.templates.filter((t) => t.active);
    // Two workflows, each with three kinds: the Word document, the e-mail that delivers it,
    // and the field list the agent extracts to.
    assert.equal(active.length, 6);
    const ids = active.map((t) => t.templateId).sort();
    assert.deepEqual(ids, [
      'dados_resumo', 'dados_revisao', 'email_resumo', 'email_revisao', 'nota_resumo', 'relatorio_revisao',
    ]);
    assert.ok(active.every((t) => t.version === 1));
    // Second read (re-seed path) must not bump versions.
    const again = await api('/api/templates', { jar });
    assert.ok(again.data.templates.filter((t) => t.active).every((t) => t.version === 1));
  });

  it('generates a DOCX version from validated items with the Anexo de fontes', async () => {
    const jar = await loginAdmin();
    const generated = await api(`/api/analyses/${analysisId}/versions`, { method: 'POST', jar });
    assert.equal(generated.data.ok, true, JSON.stringify(generated.data));
    const version = generated.data.version;
    assert.equal(version.versionNo, 1);
    assert.equal(version.origin, 'generated');
    assert.equal(version.templateId, 'nota_resumo');
    assert.equal(version.templateVersion, 1);
    assert.match(version.filename, /_v1a\.docx$/); // path nomenclature: v<seq><letter>
    assert.equal(version.label, 'v1a');
    assert.match(version.note, /determinística/i); // fallback narrative, honestly marked

    const dl = await fetchBytes(jar, `/api/analyses/${analysisId}/versions/${version.versionId}/download`);
    assert.equal(dl.status, 200);
    const xml = await readDocxText(dl.bytes);
    // Content from accepted items, in the document.
    assert.ok(xml.includes('igualdade salarial'));
    assert.ok(xml.includes('30 de abril'));
    // The user-rejected item is NOT in the document.
    assert.equal(xml.includes('CONTEUDO-REJEITADO-PELO-UTILIZADOR'), false);
    // Anexo de fontes carries every accepted citation (document, page, excerpt).
    assert.ok(xml.includes('Anexo de fontes'));
    assert.ok(xml.includes('trabalho igual sal'));
    assert.ok(xml.includes('até 30 de abril'));
    // No unrendered template tags survive.
    assert.equal(xml.includes('{#'), false);

    // The Grupo Barraqueiro letterhead reaches the generated document. Asserted on the
    // OUTPUT, not on the template file: docxtemplater rebuilds the package, so this is the
    // only place that proves the header part and its image survive the render.
    const { default: PizZip } = await import('pizzip');
    const out = new PizZip(Buffer.from(dl.bytes));
    const header = out.file('word/header1.xml');
    assert.ok(header, 'the generated document has no header part');
    assert.match(header.asText(), /<w:drawing>/, 'the header carries no image');
    assert.ok(out.file('word/media/logotipo.jpeg'), 'the logo image is missing from the package');
    // Referenced from the section, or Word renders a header nobody sees.
    assert.match(out.file('word/document.xml').asText(), /<w:headerReference[^>]*w:type="default"/);
  });

  it('versions are immutable and append-only; manual upload is a new version', async () => {
    const jar = await loginAdmin();
    const before1 = await api(`/api/analyses/${analysisId}/versions`, { jar });
    const v1 = before1.data.versions[0];

    // Manual upload (any zip-shaped bytes stand in for an edited DOCX).
    const docxBytes = readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'documento-word.docx'));
    const res = await fetch(`${BASE}/api/analyses/${analysisId}/versions/manual`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: docxBytes,
    });
    const uploaded = await res.json();
    assert.equal(uploaded.ok, true);
    assert.equal(uploaded.version.versionNo, 2);
    assert.equal(uploaded.version.origin, 'manual');
    assert.match(uploaded.version.note, /manualmente/);

    // v1 is untouched: same sha, same filename.
    const after1 = await api(`/api/analyses/${analysisId}/versions`, { jar });
    const v1After = after1.data.versions.find((v) => v.versionId === v1.versionId);
    assert.equal(v1After.sha256, v1.sha256);
    assert.equal(v1After.filename, v1.filename);

    // Not-a-docx refused.
    const bad = await fetch(`${BASE}/api/analyses/${analysisId}/versions/manual`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: Buffer.from('not a docx at all'),
    });
    assert.equal((await bad.json()).ok, false);
    assert.equal(bad.status, 400);
  });

  it('exactly one final at a time; a new final strips the previous (§14)', async () => {
    const jar = await loginAdmin();
    const list = await api(`/api/analyses/${analysisId}/versions`, { jar });
    const [v1, v2] = list.data.versions;

    const setV1 = await api(`/api/analyses/${analysisId}/versions/${v1.versionId}/final`, { method: 'POST', jar });
    assert.equal(setV1.data.version.isFinal, true);

    const setV2 = await api(`/api/analyses/${analysisId}/versions/${v2.versionId}/final`, { method: 'POST', jar });
    assert.equal(setV2.data.version.isFinal, true);
    const finals = setV2.data.versions.filter((v) => v.isFinal);
    assert.equal(finals.length, 1);
    assert.equal(finals[0].versionId, v2.versionId);

    // The trail recorded it all (§5.5).
    const detail = await api(`/api/analyses/${analysisId}`, { jar });
    const kinds = detail.data.events.map((e) => e.kind);
    assert.ok(kinds.includes('version_generated'));
    assert.ok(kinds.includes('version_uploaded_manual'));
    assert.ok(kinds.filter((k) => k === 'version_set_final').length >= 2);
  });

  it('workspace is closed before pronta_para_revisao', async () => {
    const jar = await loginAdmin();
    const created = await api('/api/analyses', {
      method: 'POST',
      body: { type: 'summary', mainDocumentId: 'doc_main' },
      jar,
    });
    const freshId = created.data.analysis.analysisId;
    const generate = await api(`/api/analyses/${freshId}/versions`, { method: 'POST', jar });
    assert.equal(generate.status, 409);
    // The refusal is the workflow definition's own sentence — the same one the UI shows
    // as the reason the button is disabled.
    assert.match(generate.data.error, /não é possível no estado "Rascunho"/);
  });
});
