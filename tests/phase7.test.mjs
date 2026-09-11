import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loginAdmin, startServer, stopServer, testDataDir, seedExtraction, settledConversion } from './helpers.mjs';

// Phase 7 — the §17 zero-tolerance acceptance suite, over the fake-Graph layer (the
// harness sets LEGAL_FAKE_GRAPH=1: "OneDrive" is a local directory, conversion produces a
// real one-page PDF embedding the DOCX hash, and a FAILCONV marker forces the failure
// path). Every §17 automated check from the briefing is here.

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

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

let analysisId = '';

describe('phase 7 — final/PDF/email: the §17 acceptance suite (fake Graph)', () => {
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
    await authedFetch(jar, '/api/library/documents/doc_main/original', {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
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
    // This suite starts at the document, so its extraction is already approved — the
    // workflow will not offer a PDF phase to an analysis whose output nobody reviewed.
    const extractionId = seedExtraction(d, analysisId, `ext_${analysisId.slice(-8)}`, { approvedAt: Date.now() });
    d.prepare(
      `INSERT INTO analysis_items (item_id, analysis_id, extraction_id, seq, kind, payload_json, accepted, created_at)
       VALUES ('itm_p7_0', ?, ?, 0, 'statement', ?, 1, ?)`,
    ).run(analysisId, extractionId, JSON.stringify({
      statement_type: 'obligation',
      content: 'Garantir a igualdade salarial.',
      source_document_id: 'doc_main', source_version: '', source_page: 1,
      source_excerpt: 'trabalho igual salário igual', evidence_quality: 'direct', ai_suggestion: false,
    }), now);
    d.close();
    await api(`/api/analyses/${analysisId}/versions`, { method: 'POST', jar }); // v01
  });
  after(async () => {
    await stopServer();
  });

  it('email is blocked before any final exists, with the reason', async () => {
    const jar = await loginAdmin();
    const gate = await api(`/api/analyses/${analysisId}/email-draft`, { jar });
    assert.equal(gate.data.allowed, false);
    assert.match(gate.data.reason, /versão final/i);
    const post = await api(`/api/analyses/${analysisId}/email-draft`, { method: 'POST', body: {}, jar });
    assert.equal(post.status, 409);
  });

  it('set-final runs the chain: DOCX + PDF on OneDrive, pages > 0, hashes bound (§17)', async () => {
    const jar = await loginAdmin();
    const versions = await api(`/api/analyses/${analysisId}/versions`, { jar });
    const v1 = versions.data.versions[0];

    const setFinal = await api(`/api/analyses/${analysisId}/versions/${v1.versionId}/final`, { method: 'POST', jar });
    assert.equal(setFinal.data.ok, true, JSON.stringify(setFinal.data));
    // The chain runs after the response: approving the document is a click, not a reason
    // to hold a request open for as long as OneDrive takes. Which of the two in-flight
    // states it is caught in is a race, and not the contract.
    assert.ok(
      ['pendente', 'em_conversao'].includes(setFinal.data.conversion.state),
      `set-final returns while the conversion is still running, got ${setFinal.data.conversion.state}`,
    );
    const conv = await settledConversion(analysisId, setFinal.data.conversion.conversionId, jar);
    assert.equal(conv.state, 'pronto_para_revisao');
    // §17: hash correspondence DOCX ↔ conversion record.
    assert.equal(conv.docxSha256, v1.sha256);
    // §17: PDF exists, has size, pages > 0; filename carries the version.
    assert.ok(conv.pdfSize > 0);
    assert.ok(conv.pdfPages > 0);
    assert.match(conv.pdfFilename, /_v1a_final\.pdf$/);
    // §17: correct OneDrive storage — the three outputs in this ANALYSIS's own folder,
    // under the generated-documents folder and split by workflow.
    const workflowFolder = path.join(testDataDir(), 'fake-onedrive', '3. Resultados', 'Resumo documental');
    const analysisFolders = readdirSync(workflowFolder).filter((entry) =>
      statSync(path.join(workflowFolder, entry)).isDirectory(),
    );
    assert.equal(analysisFolders.length, 1, 'outputs must be grouped in one folder per analysis');
    assert.ok(analysisFolders[0].includes(analysisId.slice(-6)), 'the folder is named after the analysis');
    const stored = readdirSync(path.join(workflowFolder, analysisFolders[0]));
    assert.ok(stored.includes(v1.filename), 'final DOCX must be on OneDrive');
    assert.ok(stored.includes(conv.pdfFilename), 'generated PDF must be on OneDrive');
    // The machine-readable half of the same work, beside the two documents.
    assert.ok(conv.jsonFilename, 'the conversion records its exported data');
    assert.ok(stored.includes(conv.jsonFilename), 'exported analysis data must be on OneDrive');
    const exported = JSON.parse(
      readFileSync(path.join(workflowFolder, analysisFolders[0], conv.jsonFilename), 'utf8'),
    );
    assert.equal(exported.schema, 'legal-assistant/analysis-export@1');
    assert.equal(exported.version.label, 'v1a');
    assert.ok(Array.isArray(exported.items) && exported.items.length > 0, 'the export carries the extracted items');
    assert.ok(
      exported.items.every((item) => 'accepted' in item && 'rejectionReason' in item),
      'every item carries its decision and, when rejected, the reason',
    );
    // §17: the PDF served for preview matches the recorded pdf hash.
    const pdfRes = await authedFetch(jar, `/api/analyses/${analysisId}/conversions/${conv.conversionId}/pdf`);
    const pdfBytes = Buffer.from(await pdfRes.arrayBuffer());
    assert.equal(createHash('sha256').update(pdfBytes).digest('hex'), conv.pdfSha256);
    // The fake PDF embeds the DOCX hash — binding is real, not coincidental.
    assert.ok(pdfBytes.toString('latin1').includes(v1.sha256));
  });

  it('email blocked while PDF awaits approval; approval opens it; draft attaches ONLY the PDF (§16/§17)', async () => {
    const jar = await loginAdmin();
    const gateBefore = await api(`/api/analyses/${analysisId}/email-draft`, { jar });
    assert.equal(gateBefore.data.allowed, false);
    assert.match(gateBefore.data.reason, /não foi aprovado/i);

    const convs = await api(`/api/analyses/${analysisId}/conversions`, { jar });
    const conv = convs.data.conversions[0];
    const approved = await api(`/api/analyses/${analysisId}/conversions/${conv.conversionId}/approve`, {
      method: 'POST',
      jar,
    });
    assert.equal(approved.data.conversion.state, 'aprovado_para_envio');
    assert.ok(approved.data.conversion.approvedBy.includes('@'));

    const gate = await api(`/api/analyses/${analysisId}/email-draft`, { jar });
    assert.equal(gate.data.allowed, true);
    assert.equal(gate.data.summary.pdfName, conv.pdfFilename);
    assert.equal(gate.data.summary.docxVersionNo, 1);

    // The .eml itself is built in the closing test below: downloading it IS the approval,
    // and approving concludes the analysis, so it cannot happen mid-suite.
  });

  it('a NEW version invalidates the approved PDF; email blocks as desatualizado (§16/§17)', async () => {
    const jar = await loginAdmin();
    const manual = await authedFetch(jar, `/api/analyses/${analysisId}/versions/manual`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'documento-word.docx')),
    });
    assert.equal((await manual.json()).ok, true);

    const convs = await api(`/api/analyses/${analysisId}/conversions`, { jar });
    assert.equal(convs.data.conversions[0].state, 'desatualizado');

    const gate = await api(`/api/analyses/${analysisId}/email-draft`, { jar });
    assert.equal(gate.data.allowed, false);
    assert.match(gate.data.reason, /convertida|desatualizado/i);
    const post = await api(`/api/analyses/${analysisId}/email-draft`, { method: 'POST', body: {}, jar });
    assert.equal(post.status, 409);
  });

  it('conversion failure: erro state, DOCX untouched, no old-PDF fallback, retry offered (§16/§17)', async () => {
    const jar = await loginAdmin();
    // A "docx" whose bytes trip the fake conversion failure.
    const failingDocx = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('FAILCONV padding padding')]);
    const upload = await authedFetch(jar, `/api/analyses/${analysisId}/versions/manual`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: failingDocx,
    });
    const uploaded = await upload.json();
    assert.equal(uploaded.ok, true);
    const failingVersion = uploaded.version;

    const setFinal = await api(`/api/analyses/${analysisId}/versions/${failingVersion.versionId}/final`, {
      method: 'POST',
      jar,
    });
    assert.equal(setFinal.data.ok, true);
    const conv = await settledConversion(analysisId, setFinal.data.conversion.conversionId, jar);
    assert.equal(conv.state, 'erro');
    assert.match(conv.stateDetail, /FAILCONV/);
    // §17: conversion failure never uses an older PDF — the draft stays blocked…
    const gate = await api(`/api/analyses/${analysisId}/email-draft`, { jar });
    assert.equal(gate.data.allowed, false);
    assert.match(gate.data.reason, /falhou/i);
    // …and the DOCX version is untouched (same sha, still downloadable).
    const versions = await api(`/api/analyses/${analysisId}/versions`, { jar });
    const still = versions.data.versions.find((v) => v.versionId === failingVersion.versionId);
    assert.equal(still.sha256, failingVersion.sha256);
    const dl = await authedFetch(jar, `/api/analyses/${analysisId}/versions/${failingVersion.versionId}/download`);
    assert.equal(dl.status, 200);
    // Retry exists and reports the same honest failure (the marker is in the bytes).
    const retry = await api(`/api/analyses/${analysisId}/conversions/${conv.conversionId}/retry`, {
      method: 'POST',
      jar,
    });
    assert.equal(retry.data.conversion.state, 'erro');

    // The §5.5 trail recorded the whole endgame.
    const detail = await api(`/api/analyses/${analysisId}`, { jar });
    const kinds = detail.data.events.map((e) => e.kind);
    for (const kind of ['pdf_converted', 'pdf_approved', 'email_draft_created', 'pdf_conversion_failed']) {
      assert.ok(kinds.includes(kind), `missing event ${kind}`);
    }
  });

  it('every artifact is its own feed entry, so the chat can show and open each one', async () => {
    const jar = await loginAdmin();
    const timeline = await api(`/api/analyses/${analysisId}/timeline`, { jar });
    const kinds = timeline.data.feed.map((e) => e.kind);
    for (const kind of ['extraction', 'version', 'conversion']) {
      assert.ok(kinds.includes(kind), `the feed carries the ${kind} artifact`);
    }
    // The PDF is a separate entry, not something grafted onto the document's entry.
    const conversion = timeline.data.feed.find((e) => e.kind === 'conversion');
    assert.ok(conversion.data.pdfFilename, 'and it carries what the card needs to show it');
  });

  it('§17: the draft is blocked in every state a PDF can be in, and says which one', async () => {
    const jar = await loginAdmin();
    const convs = await api(`/api/analyses/${analysisId}/conversions`, { jar });
    const conv = convs.data.conversions[0];
    const d = await db();
    const setState = (state) =>
      d.prepare('UPDATE conversions SET state = ? WHERE conversion_id = ?').run(state, conv.conversionId);
    const before = conv.state;

    // Each state the briefing names, and the reason the user is given for it. Asserted by
    // setting the state rather than by racing the conversion, so the rule is what is
    // tested and not the timing.
    for (const [state, expected] of [
      ['pendente', /ainda está a decorrer/i],
      ['em_conversao', /ainda está a decorrer/i],
      ['erro', /falhou/i],
      ['desatualizado', /desatualizado/i],
      ['pronto_para_revisao', /não foi aprovado/i],
    ]) {
      setState(state);
      const gate = await api(`/api/analyses/${analysisId}/email-draft`, { jar });
      assert.equal(gate.data.allowed, false, `a PDF in "${state}" must not allow a draft`);
      assert.match(gate.data.reason, expected, `state "${state}" must say why`);

      // And the endpoint refuses too — the gate is advisory on GET, enforcing on POST.
      const blocked = await api(`/api/analyses/${analysisId}/email-draft`, { method: 'POST', jar });
      assert.equal(blocked.status === 409 || blocked.status === 400, true, `POST must refuse in "${state}"`);
    }

    setState(before);
    d.close();
  });

  it('a new final on a fresh version converts cleanly and re-arms the email gate (§17)', async () => {
    const jar = await loginAdmin();
    // Generate a clean new version and finalize it.
    const generated = await api(`/api/analyses/${analysisId}/versions`, { method: 'POST', jar });
    const fresh = generated.data.version;
    const setFinal = await api(`/api/analyses/${analysisId}/versions/${fresh.versionId}/final`, { method: 'POST', jar });
    const conv = await settledConversion(analysisId, setFinal.data.conversion.conversionId, jar);
    assert.equal(conv.state, 'pronto_para_revisao');
    assert.equal(conv.docxSha256, fresh.sha256);
    assert.match(conv.pdfFilename, new RegExp(`_${fresh.label}_final\\.pdf$`));

    await api(`/api/analyses/${analysisId}/conversions/${conv.conversionId}/approve`, { method: 'POST', jar });
    const gate = await api(`/api/analyses/${analysisId}/email-draft`, { jar });
    assert.equal(gate.data.allowed, true);
    assert.equal(gate.data.summary.docxVersionNo, fresh.versionNo);

    // Approving the PDF prepares the e-mail: the draft is an artifact waiting to be
    // edited, not a template regenerated on every read.
    const prepared = await api(`/api/analyses/${analysisId}/email-draft/content`, { jar });
    assert.equal(prepared.data.ok, true);
    assert.ok(prepared.data.content.subject, 'the draft is prepared on PDF approval');
  });

  it('approving the e-mail closes the analysis; reverting is what reopens it', async () => {
    const jar = await loginAdmin();

    // The gate is open and the workflow stands at the E-mail phase.
    const before = await api(`/api/analyses/${analysisId}/timeline`, { jar });
    assert.equal(before.data.workflow.phase.key, 'email');
    assert.equal(before.data.workflow.closed, false);

    const convs = await api(`/api/analyses/${analysisId}/conversions`, { jar });
    const conv = convs.data.conversions.find((c) => c.state === 'aprovado_para_envio');

    const prematureDownload = await api(`/api/analyses/${analysisId}/email-draft/download`, { method: 'POST', jar });
    assert.equal(prematureDownload.status, 409);
    assert.match(prematureDownload.data.error, /aprove primeiro/i);

    // Approval closes the analysis without triggering a browser download.
    const approval = await api(`/api/analyses/${analysisId}/email-draft`, { method: 'POST', jar });
    assert.equal(approval.data.ok, true);
    assert.equal(approval.data.analysis.closedAt > 0, true);

    // Download is a separate, repeatable action. It carries the right PDF and never a DOCX (§17).
    const draftRes = await authedFetch(jar, `/api/analyses/${analysisId}/email-draft/download`, { method: 'POST' });
    assert.equal(draftRes.status, 200);
    const eml = Buffer.from(await draftRes.arrayBuffer()).toString('utf8');
    assert.ok(eml.includes(`filename="${conv.pdfFilename}"`));
    assert.ok(eml.includes('Content-Type: application/pdf'));
    assert.equal(/filename="[^"]*\.docx"/.test(eml), false);
    assert.equal(eml.includes('wordprocessingml'), false);
    assert.ok(eml.includes('To:'));
    assert.ok(eml.includes('X-Unsent: 1'));

    // One act, one event. Approving used to write email_approved twice — once by the act
    // and once by the closing — so the chat said it twice and the graph drew two identical
    // end cards. And approving the PDF used to record an e-mail EDIT nobody made.
    const trail = await api(`/api/analyses/${analysisId}`, { jar });
    const kinds = trail.data.events.map((e) => e.kind);
    assert.equal(kinds.filter((k) => k === 'email_approved').length, 1, 'the approval is recorded once');
    assert.equal(kinds.filter((k) => k === 'analysis_closed').length, 1, 'and the closing once');
    assert.equal(kinds.includes('email_draft_edited'), false, 'preparing a draft is not an edit');

    const closed = await api(`/api/analyses/${analysisId}/timeline`, { jar });
    assert.equal(closed.data.workflow.closed, true);
    assert.equal(closed.data.workflow.stateLabel, 'Concluída');
    assert.equal(closed.data.workflow.actions.length, 0, 'a concluded analysis offers no further workflow transition');
    assert.ok(closed.data.workflow.notices.some((n) => n.id === 'closed'));
    const editAfterApproval = await api(`/api/analyses/${analysisId}/email-draft/content`, {
      method: 'PUT', body: { subject: 'Alteração tardia' }, jar,
    });
    assert.equal(editAfterApproval.status, 409);
    assert.match(editAfterApproval.data.error, /já não pode ser alterado/i);

    // Read-only: every action refuses with the same sentence the UI would have shown.
    const blocked = await api(`/api/analyses/${analysisId}/versions`, { method: 'POST', jar });
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.error, /concluída/i);

    // Reverting is the way back in — and it reopens the analysis on a new path.
    const reverted = await api(`/api/analyses/${analysisId}/track-back`, {
      method: 'POST',
      body: { stage: 'documento', guidance: 'Rever o parágrafo final.' },
      jar,
    });
    assert.equal(reverted.data.ok, true);
    const reopened = await api(`/api/analyses/${analysisId}/timeline`, { jar });
    assert.equal(reopened.data.workflow.closed, false, 'reverting reopens a concluded analysis');
    assert.notEqual(reopened.data.activePath, 'a', 'and continues on a new path');
  });
});
