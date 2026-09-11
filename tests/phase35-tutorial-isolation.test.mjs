import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loadTsModule, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

async function db() {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
}

const PROTECTED = [
  'analyses', 'analysis_documents', 'analysis_items', 'analysis_extractions', 'analysis_events',
  'analysis_versions', 'analysis_paths', 'analysis_turns', 'conversions', 'relations',
  'relation_candidates', 'relation_coverage',
];

function counts(database) {
  return Object.fromEntries(PROTECTED.map((table) => [table, database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
}

function authedFetch(jar, requestPath) {
  return fetch(`${BASE}${requestPath}`, {
    headers: { cookie: [...jar.cookies].map(([key, value]) => `${key}=${value}`).join('; ') },
    redirect: 'manual',
  });
}

let jar;
let baseline;
let bytes;

describe('phase 35 — tutorials are private simulations outside real workflows', () => {
  before(async () => {
    await startServer();
    jar = await loginAdmin();
    bytes = Buffer.from('%PDF-1.4\nTutorial privado Barraqueiro\n%%EOF', 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const originals = path.join(testDataDir(), 'files', 'originals');
    mkdirSync(originals, { recursive: true });
    writeFileSync(path.join(originals, sha256), bytes);

    const d = await db();
    const now = Date.now();
    d.prepare(
      `INSERT INTO documents
         (document_id, drive_item_id, name, path, mime, size, sha256, state, title, subject, page_count,
          removed, synced_at, created_at, updated_at)
       VALUES ('doc_tutorial_source', 'drive_tutorial_source', 'Regulamento de treino.pdf',
               '1. Documentos oficiais Barraqueiro/Regulamento de treino.pdf', 'application/pdf', ?, ?,
               'indexed', 'Regulamento de treino', 'Conservação de registos', 1, 0, ?, ?, ?)`,
    ).run(bytes.length, sha256, now, now, now);
    d.prepare(
      `INSERT INTO document_pages (document_id, page, text, ocr, pending_ocr, updated_at)
       VALUES ('doc_tutorial_source', 1, 'Conservar o registo durante o prazo aplicável.', 0, 0, ?)`,
    ).run(now);
    baseline = counts(d);
    d.close();
  });

  after(async () => stopServer());

  it('snapshots one selected Library document without adding a Library row', async () => {
    for (const kind of ['library', 'summary', 'revision']) {
      const result = await api('/api/tutorials/fixtures', {
        method: 'POST', body: { kind, documentId: 'doc_tutorial_source' }, jar,
      });
      assert.equal(result.status, 201, JSON.stringify(result.data));
      assert.equal(result.data.fixture.sourceSha256, createHash('sha256').update(bytes).digest('hex'));
      assert.match(result.data.fixture.snapshotRelpath, /^tutorials\/fixtures\//);
    }
    const d = await db();
    assert.deepEqual(counts(d), baseline);
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM tutorial_fixtures').get().n, 3);
    d.close();
  });

  it('plays every guided interaction from the real entry point to completion without real mutations', async () => {
    const { TUTORIALS } = await loadTsModule('src/lib/tutorials.ts');
    for (const kind of ['library', 'summary', 'revision']) {
      const tutorial = TUTORIALS[kind];
      assert.equal(tutorial.steps[0].screen, 'home');
      assert.equal(tutorial.steps.at(-1).screen, 'finish');
      assert.ok(tutorial.steps.every((step) => step.target && step.instruction && step.consequence));

      const started = await api('/api/tutorials/runs', { method: 'POST', body: { kind }, jar });
      assert.equal(started.status, 201, JSON.stringify(started.data));
      const runId = started.data.run.runId;
      for (const [index, step] of tutorial.steps.entries()) {
        if (step.interaction) {
          const used = await api(`/api/tutorials/runs/${runId}`, {
            method: 'PATCH', body: { action: 'demo-next', ...step.interaction }, jar,
          });
          assert.equal(used.status, 200, `${kind}/${step.id}: ${JSON.stringify(used.data)}`);
          assert.deepEqual(used.data.run.demoState[step.interaction.key], step.interaction.value);
          assert.equal(used.data.run.currentStep, Math.min(index + 1, tutorial.steps.length - 1));
        } else {
          const action = index === tutorial.steps.length - 1 ? 'complete' : 'next';
          const advanced = await api(`/api/tutorials/runs/${runId}`, { method: 'PATCH', body: { action }, jar });
          assert.equal(advanced.status, 200, `${kind}/${step.id}`);
        }
      }
      const finished = await api(`/api/tutorials/runs/${runId}`, { jar });
      assert.ok(finished.data.run.completedAt);
      assert.equal((await api(`/api/tutorials/runs/${runId}`, { method: 'PATCH', body: { action: 'back' }, jar })).status, 200);
      const restarted = await api(`/api/tutorials/runs/${runId}`, { method: 'PATCH', body: { action: 'restart' }, jar });
      assert.equal(restarted.data.run.currentStep, 0);
      assert.equal(restarted.data.run.completedAt, null);
      const repeated = await api('/api/tutorials/runs', { method: 'POST', body: { kind }, jar });
      assert.notEqual(repeated.data.run.runId, runId);
      const skipped = await api(`/api/tutorials/runs/${repeated.data.run.runId}`, { method: 'PATCH', body: { action: 'skip' }, jar });
      assert.ok(skipped.data.run.completedAt);
    }
    const d = await db();
    assert.deepEqual(counts(d), baseline);
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM tutorial_runs').get().n, 6);
    d.close();
  });

  it('going back clears the destination and later actions so no repeated step is skipped', async () => {
    const { TUTORIALS } = await loadTsModule('src/lib/tutorials.ts');
    const started = await api('/api/tutorials/runs', { method: 'POST', body: { kind: 'summary' }, jar });
    const runId = started.data.run.runId;
    for (const step of TUTORIALS.summary.steps.slice(0, 3)) {
      const advanced = await api(`/api/tutorials/runs/${runId}`, { method: 'PATCH', body: { action: 'demo-next', ...step.interaction }, jar });
      assert.equal(advanced.status, 200);
    }
    const backed = await api(`/api/tutorials/runs/${runId}`, { method: 'PATCH', body: { action: 'back' }, jar });
    assert.equal(backed.data.run.currentStep, 2);
    assert.equal(backed.data.run.demoState.mainConfirmed, false);
    assert.equal(backed.data.run.demoState.sourceConfirmed, false);
    assert.equal(backed.data.run.demoState.typeChosen, 'summary');
  });

  it('migrates a resumable v1 run to scenario v6 by stable task id', async () => {
    const started = await api('/api/tutorials/runs', { method: 'POST', body: { kind: 'library' }, jar });
    const runId = started.data.run.runId;
    const d = await db();
    d.prepare('UPDATE tutorial_runs SET current_step = 8, demo_state_json = ? WHERE run_id = ?')
      .run(JSON.stringify({ _scenarioVersion: 1, openedTemplateFolder: true }), runId);
    d.close();

    const resumed = await api(`/api/tutorials/runs/${runId}`, { jar });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.data.tutorial.steps[resumed.data.run.currentStep].id, 'open-templates');
    assert.equal(resumed.data.run.scenarioVersion, 6);
    assert.equal(resumed.data.run.demoState._scenarioVersion, 6);
    assert.equal(resumed.data.run.demoState.openedTemplateFolder, true);
  });

  it('maps v3 Resumo and Revisão runs by stable task id after inserting observation steps', async () => {
    for (const [kind, oldIndex, expectedId] of [['summary', 8, 'approve-findings'], ['revision', 7, 'legal-decision']]) {
      const started = await api('/api/tutorials/runs', { method: 'POST', body: { kind }, jar });
      const d = await db();
      d.prepare('UPDATE tutorial_runs SET current_step = ?, demo_state_json = ? WHERE run_id = ?')
        .run(oldIndex, JSON.stringify({ _scenarioVersion: 3 }), started.data.run.runId);
      d.close();
      const resumed = await api(`/api/tutorials/runs/${started.data.run.runId}`, { jar });
      assert.equal(resumed.data.tutorial.steps[resumed.data.run.currentStep].id, expectedId);
      assert.equal(resumed.data.run.scenarioVersion, 6);
    }
  });

  it('maps v4 runs by stable task id after adding history, branches and chat practice', async () => {
    for (const [kind, oldIndex, expectedId] of [['summary', 10, 'approve-word'], ['revision', 11, 'decide-retry']]) {
      const started = await api('/api/tutorials/runs', { method: 'POST', body: { kind }, jar });
      const d = await db();
      d.prepare('UPDATE tutorial_runs SET current_step = ?, demo_state_json = ? WHERE run_id = ?')
        .run(oldIndex, JSON.stringify({ _scenarioVersion: 4 }), started.data.run.runId);
      d.close();
      const resumed = await api(`/api/tutorials/runs/${started.data.run.runId}`, { jar });
      assert.equal(resumed.data.tutorial.steps[resumed.data.run.currentStep].id, expectedId);
      assert.equal(resumed.data.run.scenarioVersion, 6);
    }
  });

  it('maps v5 runs after separating e-mail approval and download', async () => {
    for (const kind of ['summary', 'revision']) {
      const started = await api('/api/tutorials/runs', { method: 'POST', body: { kind }, jar });
      const definition = await api(`/api/tutorials/runs/${started.data.run.runId}`, { jar });
      const oldSteps = definition.data.tutorial.steps.filter((step) => step.id !== 'approve-email');
      const oldIndex = oldSteps.findIndex((step) => step.id === 'prepare-email');
      const d = await db();
      d.prepare('UPDATE tutorial_runs SET current_step = ?, demo_state_json = ? WHERE run_id = ?')
        .run(oldIndex, JSON.stringify({ _scenarioVersion: 5, emailSaved: true }), started.data.run.runId);
      d.close();
      const resumed = await api(`/api/tutorials/runs/${started.data.run.runId}`, { jar });
      assert.equal(resumed.data.tutorial.steps[resumed.data.run.currentStep].id, 'prepare-email');
      assert.equal(resumed.data.run.scenarioVersion, 6);
    }
  });

  it('serves the immutable bytes only to the run owner', async () => {
    const started = await api('/api/tutorials/runs', { method: 'POST', body: { kind: 'summary' }, jar });
    const runId = started.data.run.runId;
    const privateResponse = await fetch(`${BASE}/api/tutorials/runs/${runId}/document`, { redirect: 'manual' });
    assert.ok(privateResponse.status === 401 || privateResponse.status === 307);
    const response = await authedFetch(jar, `/api/tutorials/runs/${runId}/document`);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  });
});
