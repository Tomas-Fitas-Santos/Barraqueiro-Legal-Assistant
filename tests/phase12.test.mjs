import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loginAdmin, startServer, stopServer, testDataDir, seedExtraction } from './helpers.mjs';

// Phase 12 — the anti-drift suite.
//
// The workflow definition is only worth having if the API obeys it. This walks an analysis
// through every phase and, at each one, checks the two halves of that promise:
//
//   • a DISABLED action refuses when called, with the BYTE-IDENTICAL sentence the status
//     gave as the reason it was disabled;
//   • an ENABLED action is callable — its URL resolves, and it does not answer 409.
//
// If a rule is ever implemented a second time in a route, or a message is reworded in one
// place and not the other, this suite fails. That is its whole job.

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

async function db() {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
}

/** Call an action exactly as the UI would: the method and URL the status handed over. */
async function callAction(action, jar) {
  return api(action.path, { method: action.method, body: action.method === 'PATCH' ? {} : undefined, jar });
}

async function statusOf(analysisId, jar) {
  const res = await api(`/api/analyses/${analysisId}/timeline`, { jar });
  return res.data.workflow;
}

/** Every disabled action of the current phase refuses with its own stated reason. */
async function assertDisabledActionsAgree(analysisId, jar) {
  const workflow = await statusOf(analysisId, jar);
  let checked = 0;
  // Actions offered on the gate AND the ones that live on an artifact card — the contract
  // is the same wherever the button is drawn.
  for (const action of [...workflow.actions, ...Object.values(workflow.surfaces)]) {
    if (action.enabled) continue;
    // No path means the artifact it acts on does not exist yet — there is nothing to call.
    if (!action.path) continue;
    const res = await callAction(action, jar);
    assert.ok(
      res.status === 409 || res.status === 400,
      `${action.id} is disabled but answered ${res.status}`,
    );
    assert.equal(
      res.data.error,
      action.disabledReason,
      `${action.id}: the API and the UI must give the SAME reason`,
    );
    checked += 1;
  }
  return { checked, phase: workflow.phase.key };
}

let analysisId = '';
let jar;

describe('phase 12 — the API obeys the workflow definition (no model calls)', () => {
  before(async () => {
    await startServer();
    jar = await loginAdmin();
    const bytes = readFileSync(path.join(FIXTURES, 'nota-interna-transparencia-salarial.pdf'));
    const d0 = await db();
    const now = Date.now();
    d0.prepare(
      `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
       VALUES ('doc_x12', 'local-doc_x12', 'Nota Interna.pdf', '', 'application/pdf', 0, 'listed', 0, ?, ?, ?)`,
    ).run(now, now, now);
    d0.close();
    await fetch(`${BASE}/api/library/documents/doc_x12/original`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: bytes,
    });
    const created = await api('/api/analyses', {
      method: 'POST',
      body: { type: 'summary', mainDocumentId: 'doc_x12' },
      jar,
    });
    analysisId = created.data.analysis.analysisId;
  });

  after(async () => {
    await stopServer();
  });

  it('Extração: the run is refused for the reason the status gives (AI is off in this suite)', async () => {
    const { checked, phase } = await assertDisabledActionsAgree(analysisId, jar);
    assert.equal(phase, 'extracao');
    assert.ok(checked > 0, 'there is something disabled to check');

    // And the reason is the honest one, not a generic refusal.
    const workflow = await statusOf(analysisId, jar);
    assert.match(workflow.actions.find((a) => a.id === 'run').disabledReason, /liga(ç|c)ão à IA/i);
  });

  it('Revisão: the approval is callable, and every URL the status hands over resolves', async () => {
    const d = await db();
    d.prepare(`UPDATE analyses SET state = 'pronta_para_revisao' WHERE analysis_id = ?`).run(analysisId);
    const extractionId = seedExtraction(d, analysisId, `ext_${analysisId.slice(-8)}`);
    d.prepare(
      `INSERT INTO analysis_items (item_id, analysis_id, extraction_id, seq, kind, payload_json, accepted, created_at)
       VALUES ('itm_x12_0', ?, ?, 0, 'statement', ?, 1, ?)`,
    ).run(analysisId, extractionId, JSON.stringify({
      topic: 'Transparência', scope: 'Grupo', statement_type: 'obligation',
      content: 'Garantir a igualdade salarial.',
      entity: '', required_action: '', suggested_owner: '', deadline: '', consequence: '', exceptions: '',
      source_document_id: 'doc_x12', source_version: '', source_page: 1,
      source_excerpt: 'igualdade', evidence_quality: 'direct', ai_suggestion: false,
    }), Date.now());
    d.prepare(`UPDATE analysis_extractions SET accepted_count = 1 WHERE extraction_id = ?`).run(extractionId);
    d.close();

    const workflow = await statusOf(analysisId, jar);
    assert.equal(workflow.phase.key, 'revisao');

    // No action may be offered with an id placeholder still in its URL: the gate posts
    // exactly what it is given, so a `:versionId` left in would be a button that 404s.
    for (const action of [...workflow.actions, ...Object.values(workflow.surfaces)]) {
      assert.equal(/:[a-zA-Z]+/.test(action.path), false, `${action.id} has an unresolved URL: ${action.path}`);
    }

    await assertDisabledActionsAgree(analysisId, jar);

    const approve = workflow.actions.find((a) => a.id === 'approve_extraction');
    assert.equal(approve.enabled, true);
    const res = await callAction(approve, jar);
    assert.notEqual(res.status, 409, `an enabled action must not refuse: ${JSON.stringify(res.data)}`);
  });

  it('Documento: approving the document is callable at the URL the status resolved', async () => {
    const workflow = await statusOf(analysisId, jar);
    assert.equal(workflow.phase.key, 'documento');
    for (const action of [...workflow.actions, ...Object.values(workflow.surfaces)]) {
      assert.equal(/:[a-zA-Z]+/.test(action.path), false, `${action.id} has an unresolved URL: ${action.path}`);
    }
    await assertDisabledActionsAgree(analysisId, jar);

    // The approval lives on the document's own card, so it is offered as a surface.
    const setFinal = workflow.surfaces.setFinal;
    assert.equal(setFinal.enabled, true, JSON.stringify(setFinal));
    const res = await callAction(setFinal, jar);
    assert.equal(res.status, 200, `set_final must be callable: ${JSON.stringify(res.data)}`);
  });

  it('PDF: the approval targets the real conversion, and refuses honestly while it runs', async () => {
    // Poll until the conversion settles, exactly as the UI does.
    let workflow = await statusOf(analysisId, jar);
    for (let i = 0; i < 120 && workflow.progress; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      workflow = await statusOf(analysisId, jar);
    }
    assert.equal(workflow.phase.key, 'pdf');
    await assertDisabledActionsAgree(analysisId, jar);

    const approve = workflow.surfaces.approvePdf;
    assert.equal(approve.enabled, true, JSON.stringify(approve));
    // The review itself is the human decision; pressing Approve must not ask twice.
    assert.equal(approve.confirm, undefined);
    const res = await callAction(approve, jar);
    assert.equal(res.status, 200, JSON.stringify(res.data));
  });

  it('E-mail: the last gate is open, and a concluded analysis refuses everything it says it will', async () => {
    const workflow = await statusOf(analysisId, jar);
    assert.equal(workflow.phase.key, 'email');
    await assertDisabledActionsAgree(analysisId, jar);
    assert.equal(workflow.surfaces.approveEmail.enabled, true);
    assert.equal(workflow.surfaces.approveEmail.confirm, undefined);
    assert.equal(workflow.surfaces.approveEmail.download, undefined);

    // Approving closes the analysis; after that every action must refuse with the reason
    // the status would have shown.
    const res = await fetch(`${BASE}/api/analyses/${analysisId}/email-draft`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: '{}',
    });
    assert.equal(res.status, 200);

    const closed = await statusOf(analysisId, jar);
    assert.equal(closed.closed, true);
    assert.equal(closed.actions.length, 0);
    // Every surface is closed too, chat included.
    for (const surface of Object.values(closed.surfaces)) {
      assert.equal(surface.enabled, false, `${surface.id} must be closed on a concluded analysis`);
    }
    const chat = await api(closed.surfaces.chat.path, { method: 'POST', body: { message: 'x' }, jar });
    assert.equal(chat.data.error, closed.surfaces.chat.disabledReason);
  });
});
