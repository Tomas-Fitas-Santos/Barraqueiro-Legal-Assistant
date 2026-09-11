import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loadTsModule, loginAdmin, startServer, stopServer, testDataDir, seedExtraction } from './helpers.mjs';

// Phase 10 — the UX layer's server contracts: deterministic stage prompts, track-back
// (fork + guidance + restart state), and inline document serving for previews.

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');
let analysisId = '';

async function db() {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
}

describe('phase 10 — track-back + previews (no model calls)', () => {
  before(async () => {
    await startServer();
    const jar = await loginAdmin();
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
      body: readFileSync(path.join(FIXTURES, 'nota-interna-transparencia-salarial.pdf')),
    });
    const created = await api('/api/analyses', {
      method: 'POST',
      body: { type: 'summary', mainDocumentId: 'doc_main', instructions: 'Foco inicial.' },
      jar,
    });
    analysisId = created.data.analysis.analysisId;
    const d = await db();
    d.prepare(`UPDATE analyses SET state = 'pronta_para_revisao' WHERE analysis_id = ?`).run(analysisId);
    const extractionId = seedExtraction(d, analysisId, `ext_${analysisId.slice(-8)}`);
    d.prepare(
      `INSERT INTO analysis_items (item_id, analysis_id, extraction_id, seq, kind, payload_json, accepted, decision, created_at)
       VALUES ('itm_p10', ?, ?, 0, 'statement', ?, 1, 'accepted', ?)`,
    ).run(analysisId, extractionId, JSON.stringify({
      statement_type: 'obligation', content: 'Obrigação.', source_document_id: 'doc_main',
      source_version: '', source_page: 1, source_excerpt: 'trabalho igual', evidence_quality: 'direct', ai_suggestion: false,
    }), now);
    d.close();
    await api(`/api/analyses/${analysisId}/versions`, { method: 'POST', jar }); // v1a
  });
  after(async () => {
    await stopServer();
  });

  it('stage prompts are deterministic, per workflow type', async () => {
    const { stagesFor, stageFor } = await loadTsModule('src/lib/server/stages.ts');
    const summary = stagesFor('summary').map((s) => s.key);
    const revision = stagesFor('revision').map((s) => s.key);
    assert.deepEqual(summary, ['configuracao', 'extracao', 'revisao', 'documento', 'pdf', 'email']);
    assert.deepEqual(revision, summary); // same keys…
    // …but the middle stage reads differently for each workflow.
    assert.notEqual(stageFor('summary', 'extracao').label, stageFor('revision', 'extracao').label);
    assert.match(stageFor('revision', 'extracao').prompt, /matriz comparativa/i);
    // Same input, same prompt — always.
    assert.equal(stageFor('summary', 'documento').prompt, stagesFor('summary').find((s) => s.key === 'documento').prompt);

    const jar = await loginAdmin();
    const api1 = await api(`/api/analyses/${analysisId}/track-back?stage=documento`, { jar });
    assert.equal(api1.data.stage.prompt, stageFor('summary', 'documento').prompt);
    const list = await api(`/api/analyses/${analysisId}/track-back`, { jar });
    assert.equal(list.data.stages.length, 6);
  });

  it('track-back forks the path, stores the guidance and resets the state', async () => {
    const jar = await loginAdmin();
    const before1 = await api(`/api/analyses/${analysisId}/timeline`, { jar });
    assert.equal(before1.data.activePath, 'a');

    const res = await api(`/api/analyses/${analysisId}/track-back`, {
      method: 'POST',
      body: { stage: 'documento', guidance: 'Mais conciso, com conclusões no fim.' },
      jar,
    });
    assert.equal(res.data.ok, true, JSON.stringify(res.data));
    assert.equal(res.data.newPath, 'b');
    assert.equal(res.data.restart, 'generate');

    const after1 = await api(`/api/analyses/${analysisId}/timeline`, { jar });
    assert.equal(after1.data.activePath, 'b');
    assert.ok(after1.data.feed.some((e) => e.kind === 'event:tracked_back'));

    // The answer belongs to the path the revert created, not to the analysis: a sibling
    // path re-run later must not inherit an instruction given while reworking this one.
    // The analysis keeps the guidance it was created with, untouched.
    assert.equal(after1.data.analysis.instructions, 'Foco inicial.');
    const d = await db();
    const paths = d
      .prepare('SELECT letter, guidance FROM analysis_paths WHERE analysis_id = ? ORDER BY letter')
      .all(analysisId);
    d.close();
    assert.match(paths.find((p) => p.letter === 'b').guidance, /Mais conciso/);
    assert.equal(paths.find((p) => p.letter === 'a').guidance, '', 'the sibling path is unaffected');

    // The next generated document lands on the new path as v1b.
    const generated = await api(`/api/analyses/${analysisId}/versions`, { method: 'POST', jar });
    assert.equal(generated.data.version.label, 'v1b');
  });

  it('track-back to revisão reopens every item decision without generating', async () => {
    const jar = await loginAdmin();
    const res = await api(`/api/analyses/${analysisId}/track-back`, {
      method: 'POST',
      body: { stage: 'revisao', guidance: 'Rejeitar sugestões da IA.' },
      jar,
    });
    assert.equal(res.data.restart, 'review_only');
    assert.equal(res.data.state, 'pronta_para_revisao');
    const timeline = await api(`/api/analyses/${analysisId}/timeline`, { jar });
    assert.ok(timeline.data.items.every((i) => i.decision === 'pending'));
  });

  it('empty guidance and unknown stages are refused', async () => {
    const jar = await loginAdmin();
    const empty = await api(`/api/analyses/${analysisId}/track-back`, {
      method: 'POST',
      body: { stage: 'documento', guidance: '   ' },
      jar,
    });
    assert.equal(empty.status, 400);
    const unknown = await api(`/api/analyses/${analysisId}/track-back`, {
      method: 'POST',
      body: { stage: 'nao_existe', guidance: 'x' },
      jar,
    });
    assert.equal(unknown.status, 400);
  });

  it('documents serve inline for preview and attachment for download', async () => {
    const jar = await loginAdmin();
    const cookie = [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const inline = await fetch(`${BASE}/api/library/documents/doc_main/download?inline=1`, { headers: { cookie } });
    assert.equal(inline.status, 200);
    assert.match(String(inline.headers.get('content-disposition')), /^inline;/);
    assert.equal(inline.headers.get('content-type'), 'application/pdf');
    const bytes = Buffer.from(await inline.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), '%PDF'); // a real PDF, not text

    const attach = await fetch(`${BASE}/api/library/documents/doc_main/download`, { headers: { cookie } });
    assert.match(String(attach.headers.get('content-disposition')), /^attachment;/);
  });
});

// Round-4 contracts: the editable e-mail draft and in-app document editing.
describe('phase 10b — editable e-mail draft + in-app document editing', () => {
  let id = '';
  before(async () => {
    await startServer();
    const jar = await loginAdmin();
    const d0 = await db();
    const now = Date.now();
    d0.prepare(
      `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
       VALUES ('doc_e', 'local-doc_e', 'Nota.pdf', '', 'application/pdf', 0, 'listed', 0, ?, ?, ?)`,
    ).run(now, now, now);
    d0.close();
    await fetch(`${BASE}/api/library/documents/doc_e/original`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: readFileSync(path.join(FIXTURES, 'nota-interna-transparencia-salarial.pdf')),
    });
    const created = await api('/api/analyses', { method: 'POST', body: { type: 'summary', mainDocumentId: 'doc_e' }, jar });
    id = created.data.analysis.analysisId;
    const d = await db();
    d.prepare(`UPDATE analyses SET state = 'pronta_para_revisao' WHERE analysis_id = ?`).run(id);
    seedExtraction(d, id, `ext_${id.slice(-6)}`);
    d.prepare(
      `INSERT INTO analysis_items (item_id, analysis_id, extraction_id, seq, kind, payload_json, accepted, created_at)
       VALUES ('itm_e', ?, ?, 0, 'statement', ?, 1, ?)`,
    ).run(id, `ext_${id.slice(-6)}`, JSON.stringify({
      statement_type: 'obligation', content: 'Obrigação.', source_document_id: 'doc_e',
      source_version: '', source_page: 1, source_excerpt: 'trabalho igual', evidence_quality: 'direct', ai_suggestion: false,
    }), now);
    d.close();
    await api(`/api/analyses/${id}/versions`, { method: 'POST', jar });
  });
  after(async () => {
    await stopServer();
  });

  it('editing a document creates a NEW version and leaves the original intact', async () => {
    const jar = await loginAdmin();
    const before1 = await api(`/api/analyses/${id}/versions`, { jar });
    const v1 = before1.data.versions[0];
    const preview = await api(`/api/analyses/${id}/versions/${v1.versionId}/preview`, { jar });
    const sections = preview.data.sections.map((s, i) => (i === 0 ? { ...s, body: `${s.body} EDITADO-NA-APP` } : s));

    const saved = await api(`/api/analyses/${id}/versions/${v1.versionId}/edit`, {
      method: 'POST',
      body: { sections },
      jar,
    });
    assert.equal(saved.data.ok, true, JSON.stringify(saved.data));
    assert.equal(saved.data.version.label, 'v2a');
    assert.match(saved.data.version.note, /Editado manualmente/);

    // the original is byte-identical, the new one carries the edit
    const after1 = await api(`/api/analyses/${id}/versions`, { jar });
    assert.equal(after1.data.versions.find((v) => v.versionId === v1.versionId).sha256, v1.sha256);
    const newPreview = await api(`/api/analyses/${id}/versions/${saved.data.version.versionId}/preview`, { jar });
    assert.ok(newPreview.data.sections[0].body.includes('EDITADO-NA-APP'));

    const empty = await api(`/api/analyses/${id}/versions/${v1.versionId}/edit`, { method: 'POST', body: { sections: [] }, jar });
    assert.equal(empty.status, 400);
  });

  it('the e-mail draft is proposed, editable, saved, and is what the .eml carries', async () => {
    const jar = await loginAdmin();
    const proposed = await api(`/api/analyses/${id}/email-draft/content`, { jar });
    assert.equal(proposed.data.ok, true);
    assert.match(proposed.data.content.subject, /Resumo documental/);
    assert.equal(proposed.data.allowed, false); // no final/PDF yet

    const saved = await api(`/api/analyses/${id}/email-draft/content`, {
      method: 'PUT',
      body: { to: 'legal@barraqueiro.pt', subject: 'Assunto próprio', body: 'Corpo escrito pelo utilizador.' },
      jar,
    });
    assert.equal(saved.data.content.to, 'legal@barraqueiro.pt');
    const reread = await api(`/api/analyses/${id}/email-draft/content`, { jar });
    assert.equal(reread.data.content.subject, 'Assunto próprio');
    assert.equal(reread.data.content.body, 'Corpo escrito pelo utilizador.');

    // Once the PDF and e-mail are approved, the separate .eml download carries exactly
    // the saved content.
    const versions = await api(`/api/analyses/${id}/versions`, { jar });
    const last = versions.data.versions[versions.data.versions.length - 1];
    const final = await api(`/api/analyses/${id}/versions/${last.versionId}/final`, { method: 'POST', jar });
    await api(`/api/analyses/${id}/conversions/${final.data.conversion.conversionId}/approve`, { method: 'POST', jar });

    const approved = await api(`/api/analyses/${id}/email-draft`, { method: 'POST', jar });
    assert.equal(approved.data.ok, true);
    const res = await fetch(`${BASE}/api/analyses/${id}/email-draft/download`, {
      method: 'POST',
      headers: { cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    const eml = Buffer.from(await res.arrayBuffer()).toString('utf8');
    assert.ok(eml.includes('To: legal@barraqueiro.pt'));
    assert.ok(eml.includes('Corpo escrito pelo utilizador.'));
    assert.ok(eml.includes(Buffer.from('Assunto próprio', 'utf8').toString('base64')));
    assert.equal(/filename="[^"]*\.docx"/.test(eml), false);
  });
});
