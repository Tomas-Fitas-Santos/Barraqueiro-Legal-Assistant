import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loginAdmin, startServer, stopServer, testDataDir, seedExtraction } from './helpers.mjs';

// Phase 9 — the chat surface's data layer: the merged timeline feed, version previews
// with resolved references, and the fork model (paths, nomenclature, parent fallback).

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

async function db() {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
}

let analysisId = '';

describe('phase 9 — timeline, previews, forks (no model calls)', () => {
  before(async () => {
    await startServer();
    const jar = await loginAdmin();
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
    d.prepare(
      `INSERT INTO analysis_items (item_id, analysis_id, extraction_id, seq, kind, payload_json, accepted, created_at)
       VALUES ('itm_p9_0', ?, ?, 0, 'statement', ?, 1, ?)`,
    ).run(analysisId, extractionId, JSON.stringify({
      statement_type: 'obligation',
      content: 'Garantir a igualdade salarial.',
      source_document_id: 'doc_main', source_version: '', source_page: 1,
      source_excerpt: 'trabalho igual salário igual', evidence_quality: 'direct', ai_suggestion: false,
    }), now);
    d.close();
  });
  after(async () => {
    await stopServer();
  });

  it('nomenclature: v1a, v2a on the first path', async () => {
    const jar = await loginAdmin();
    const g1 = await api(`/api/analyses/${analysisId}/versions`, { method: 'POST', jar });
    assert.equal(g1.data.version.label, 'v1a');
    const g2 = await api(`/api/analyses/${analysisId}/versions`, { method: 'POST', jar });
    assert.equal(g2.data.version.label, 'v2a');
    assert.match(g2.data.version.filename, /_v2a\.docx$/);
  });

  it('fork from v1a: path b becomes active; the next document is v1b', async () => {
    const jar = await loginAdmin();
    const versions = await api(`/api/analyses/${analysisId}/versions`, { jar });
    const v1a = versions.data.versions.find((v) => v.label === 'v1a');

    const fork = await api(`/api/analyses/${analysisId}/versions/${v1a.versionId}/fork`, { method: 'POST', jar });
    assert.equal(fork.data.path.letter, 'b');
    assert.equal(fork.data.path.parentLabel, 'v1a');

    const timeline = await api(`/api/analyses/${analysisId}/timeline`, { jar });
    assert.equal(timeline.data.activePath, 'b');
    assert.equal(timeline.data.paths.length, 2);

    // Chat on the fresh path passes the version guard via the fork parent's sections —
    // the only refusal left is the harness's missing AI.
    const chat = await api(`/api/analyses/${analysisId}/chat`, { method: 'POST', body: { message: 'x' }, jar });
    assert.equal(chat.status, 400);
    assert.match(chat.data.error, /liga(ç|c)ão à IA/);

    const g = await api(`/api/analyses/${analysisId}/versions`, { method: 'POST', jar });
    assert.equal(g.data.version.label, 'v1b');
    assert.equal(g.data.version.pathLetter, 'b');

    // Path a is untouched; switching back works and the next doc there is v3a.
    const back = await api(`/api/analyses/${analysisId}/paths/a/activate`, { method: 'POST', jar });
    assert.equal(back.data.activePath, 'a');
    const g3 = await api(`/api/analyses/${analysisId}/versions`, { method: 'POST', jar });
    assert.equal(g3.data.version.label, 'v3a');
  });

  it('timeline: one ordered feed with events, versions and the fork recorded', async () => {
    const jar = await loginAdmin();
    const timeline = await api(`/api/analyses/${analysisId}/timeline`, { jar });
    const feed = timeline.data.feed;
    const kinds = feed.map((e) => e.kind);
    assert.ok(kinds.includes('event:created'));
    assert.ok(kinds.includes('version'));
    assert.ok(kinds.includes('event:path_forked'));
    assert.ok(kinds.includes('event:path_switched'));
    // Ordered by time.
    for (let i = 1; i < feed.length; i++) assert.ok(feed[i].at >= feed[i - 1].at);
    // Version entries carry the label + path for the tree.
    const versionEntries = feed.filter((e) => e.kind === 'version');
    assert.ok(versionEntries.some((e) => e.data.label === 'v1b'));
    assert.equal(timeline.data.draft.allowed, false);
  });

  it('version preview resolves sections and clickable references', async () => {
    const jar = await loginAdmin();
    const versions = await api(`/api/analyses/${analysisId}/versions`, { jar });
    const v1a = versions.data.versions.find((v) => v.label === 'v1a');
    const preview = await api(`/api/analyses/${analysisId}/versions/${v1a.versionId}/preview`, { jar });
    assert.equal(preview.data.ok, true);
    assert.ok(Array.isArray(preview.data.sections) && preview.data.sections.length > 0);
    assert.equal(preview.data.references.length, 1);
    const ref = preview.data.references[0];
    assert.equal(ref.documentId, 'doc_main');
    assert.equal(ref.page, 1);
    assert.ok(ref.excerpt.includes('trabalho igual'));
  });
});
