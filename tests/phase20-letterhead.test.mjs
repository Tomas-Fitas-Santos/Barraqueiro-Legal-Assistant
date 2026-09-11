import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loginAdmin, startServer, stopServer, testDataDir, seedExtraction, settledConversion } from './helpers.mjs';

// Workstream A — the Grupo Barraqueiro letterhead.
//
// Three separate failures put the logo in the repo and nowhere the client could see it, so
// each gets its own test: the geometry was measured off the wrong document, publishing
// skipped any template that already existed, and documents generated earlier were never
// revisited. Runs over the fake-Graph layer ("OneDrive" is a local directory).

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

async function headerXmlOf(bytes) {
  const { default: PizZip } = await import('pizzip');
  const zip = new PizZip(Buffer.from(bytes));
  const header = zip.file('word/header1.xml');
  return header ? header.asText() : '';
}

let analysisId = '';
/**
 * The built-in template as the app currently renders it. It is no longer a file in the repo
 * — the block list is the template and the .docx is a product of it — so the reference here
 * is the copy publishing put in the library, captured before any test edits it.
 */
let builtin = Buffer.alloc(0);
const publishedTemplate = () =>
  path.join(testDataDir(), 'fake-onedrive', '2. Templates', 'Resumo documental', 'nota-resumo.docx');

describe('workstream A — the letterhead reaches the client', () => {
  before(async () => {
    await startServer();
    const jar = await loginAdmin();
    // Point the app at the fake drive and let it lay out the library, which is what puts the
    // built-in templates in '2. Templates' in the first place.
    await api('/api/msgraph/folder', {
      method: 'POST',
      body: { folderId: 'fake-root', folderName: 'fake-onedrive' },
      jar,
    });
    await api('/api/library/sync', { method: 'POST', jar });
    builtin = readFileSync(publishedTemplate());
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
    const extractionId = seedExtraction(d, analysisId, `ext_${analysisId.slice(-8)}`, { approvedAt: Date.now() });
    d.prepare(
      `INSERT INTO analysis_items (item_id, analysis_id, extraction_id, seq, kind, payload_json, accepted, created_at)
       VALUES ('itm_a_0', ?, ?, 0, 'statement', ?, 1, ?)`,
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

  // A1 — the geometry, measured off CÓDIGO DE CONDUTA rather than the Nota Interna. The
  // numbers are asserted because getting them from the wrong document is exactly the
  // mistake that already happened once and looked fine.
  it('carries the logo at the size and position the client’s own documents use', async () => {
    const asset = readFileSync(path.join(process.cwd(), 'assets', 'barraqueiro-header-logo.jpg'));
    assert.ok(
      asset.length > 40000,
      `the letterhead asset is ${asset.length} bytes — that is the 75x70 thumbnail from the Nota Interna again, which prints at 75 dpi`,
    );

    const xml = await headerXmlOf(builtin);
    assert.ok(xml, 'the template has no header part');
    // 25.4 mm wide (EMU = mm * 36000), the reference measurement.
    assert.match(xml, /cx="914400"/, 'the logo is not 25.4 mm wide');
    // The mark sits inside the text margin, not flush with it: 36.4 mm from the page edge
    // against a 25 mm margin leaves 11.4 mm of indent.
    assert.match(xml, /<w:ind w:right="646"\/>/, 'the logo is not indented to the reference position');

    const { default: PizZip } = await import('pizzip');
    const doc = new PizZip(builtin)
      .file('word/document.xml')
      .asText();
    assert.match(doc, /w:header="1077"/, 'the header does not start 19 mm down the page');
    assert.match(doc, /w:top="2608"/, 'the top margin does not clear the letterhead');
  });

  // A2 — publishing used to skip anything already present, so a corrected built-in could
  // never reach the library. It must now replace its own stale copy...
  it('republishes a built-in template whose bytes have moved on', async () => {
    const jar = await loginAdmin();
    const current = builtin;
    const published = publishedTemplate();

    // Stand in for the pre-letterhead state: an older built-in sitting in the library, and
    // the registry remembering it as one of ours.
    const stale = Buffer.concat([current, Buffer.from('OLD-BUILTIN')]);
    writeFileSync(published, stale);
    const staleSha = createHash('sha256').update(stale).digest('hex');
    const d = await db();
    d.prepare(
      `INSERT INTO templates (template_id, version, name, analysis_type, file_sha256, active,
                              required_fields_json, fill_rules, created_at, source, document_id, valid, validation_error)
       VALUES ('nota_resumo', 99, 'stale', 'summary', ?, 0, '[]', '', ?, 'builtin', '', 1, '')`,
    ).run(staleSha, Date.now());
    d.close();

    await api('/api/library/sync', { method: 'POST', jar });
    const after = readFileSync(published);
    assert.equal(
      after.equals(current),
      true,
      'the library still holds the old built-in — a corrected template never reaches the client',
    );
  });

  // ...while never touching a file the client has made their own.
  it('leaves a template the client has edited exactly as it is', async () => {
    const jar = await loginAdmin();
    const published = publishedTemplate();
    const clientEdit = Buffer.concat([builtin, Buffer.from('THE-CLIENT-CHANGED-THIS')]);
    writeFileSync(published, clientEdit);

    await api('/api/library/sync', { method: 'POST', jar });
    assert.equal(
      readFileSync(published).equals(clientEdit),
      true,
      'publishing overwrote a client-edited template',
    );
    writeFileSync(published, builtin);
  });

  // A3 — documents generated before the letterhead existed are rewritten where they stand:
  // same version, same OneDrive items, and an approval that still points at real bytes.
  it('rewrites an already-generated document in place, keeping its identity and approval', async () => {
    const jar = await loginAdmin();
    const generated = await api(`/api/analyses/${analysisId}/versions`, { method: 'POST', jar });
    const version = generated.data.version;
    const setFinal = await api(`/api/analyses/${analysisId}/versions/${version.versionId}/final`, {
      method: 'POST',
      jar,
    });
    const conversion = await settledConversion(analysisId, setFinal.data.conversion.conversionId, jar);
    assert.equal(conversion.state, 'pronto_para_revisao', JSON.stringify(conversion));

    // Approve it, then wind the version back to a pre-letterhead template so the backfill
    // has something to do — the marker it works from is the pinned template version.
    const approvedAt = Date.now();
    const d = await db();
    d.prepare(`UPDATE conversions SET state = 'aprovado_para_envio', approved_at = ? WHERE conversion_id = ?`).run(
      approvedAt,
      conversion.conversionId,
    );
    // Backdated as well as unpinned: the re-render dates the document from the version's own
    // created_at, so this both makes the rewritten bytes genuinely differ and proves the
    // rewrite does not silently re-date a document the client already has.
    const originalDay = '2026-01-15';
    d.prepare('UPDATE analysis_versions SET template_version = 0, created_at = ? WHERE version_id = ?').run(
      Date.parse(`${originalDay}T10:00:00Z`),
      version.versionId,
    );
    const before = d
      .prepare('SELECT onedrive_docx_id, onedrive_pdf_id, pdf_sha256 FROM conversions WHERE conversion_id = ?')
      .get(conversion.conversionId);
    d.close();

    await api('/api/library/sync', { method: 'POST', jar });

    // The backfill runs in the background; wait for the pin to come forward.
    let row = null;
    for (let i = 0; i < 60; i += 1) {
      const d2 = await db();
      row = d2
        .prepare(
          `SELECT c.onedrive_docx_id, c.onedrive_pdf_id, c.pdf_sha256, c.state, c.approved_at, v.template_version, v.sha256
             FROM conversions c JOIN analysis_versions v ON v.version_id = c.version_id
            WHERE c.conversion_id = ?`,
        )
        .get(conversion.conversionId);
      d2.close();
      if (row.template_version > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(row.template_version > 0, 'the backfill never rewrote the generated document');

    // Identity is preserved: the client's links still resolve.
    assert.equal(row.onedrive_docx_id, before.onedrive_docx_id, 'the DOCX moved to a new OneDrive item');
    assert.equal(row.onedrive_pdf_id, before.onedrive_pdf_id, 'the PDF moved to a new OneDrive item');
    // Approval survives, and still points at bytes that exist.
    assert.equal(row.state, 'aprovado_para_envio', 'the rewrite reset an approved document');
    assert.equal(row.approved_at, approvedAt);
    assert.notEqual(row.pdf_sha256, before.pdf_sha256, 'the stored PDF hash was not re-stamped');
    // The point of re-stamping: an approval must never point at a hash nothing hashes to.
    const storedPdf = readFileSync(path.join(testDataDir(), 'files', 'pdfs', row.pdf_sha256));
    assert.equal(
      createHash('sha256').update(storedPdf).digest('hex'),
      row.pdf_sha256,
      'the conversion record and the stored PDF disagree',
    );

    // The rewritten DOCX carries the letterhead, and still says the day it was written.
    const dl = await authedFetch(jar, `/api/analyses/${analysisId}/versions/${version.versionId}/download`);
    const docx = Buffer.from(await dl.arrayBuffer());
    assert.match(await headerXmlOf(docx), /<w:drawing>/, 'the rewritten document has no letterhead');
    const { default: PizZip } = await import('pizzip');
    assert.ok(
      new PizZip(docx).file('word/document.xml').asText().includes(originalDay),
      'the rewrite re-dated the document to today',
    );
  });

  // What actually happened in production: the OneDrive account had been switched, so the
  // conversion records pointed at item ids on a drive Graph no longer accepts. The file is
  // still there under the same name — it just has a new id — so the library is the truth
  // and the stale record gets healed rather than believed.
  it('finds a document whose stored item id belongs to a drive we have left', async () => {
    const jar = await loginAdmin();
    const STALE = 'OLDDRIVE1234!sdeadbeef';
    // The previous test's backfill runs in the background and is guarded against overlap;
    // let it finish, or this test's sync would find the guard closed and do nothing.
    await new Promise((r) => setTimeout(r, 1500));

    const d = await db();
    const row = d
      .prepare(
        `SELECT c.conversion_id, c.onedrive_docx_id, v.version_id
           FROM conversions c JOIN analysis_versions v ON v.version_id = c.version_id
          ORDER BY c.created_at DESC LIMIT 1`,
      )
      .get();
    // The shape an id from a previous drive has: '<otherDriveId>!<item>'.
    d.prepare('UPDATE conversions SET onedrive_docx_id = ? WHERE conversion_id = ?').run(STALE, row.conversion_id);
    d.prepare('UPDATE analysis_versions SET template_version = 0 WHERE version_id = ?').run(row.version_id);
    d.close();

    let healed = null;
    for (let i = 0; i < 40; i += 1) {
      // Re-trigger periodically: a run skipped by the overlap guard must not fail the test.
      if (i % 8 === 0) await api('/api/library/sync', { method: 'POST', jar });
      await new Promise((r) => setTimeout(r, 500));
      const d2 = await db();
      healed = d2
        .prepare('SELECT onedrive_docx_id FROM conversions WHERE conversion_id = ?')
        .get(row.conversion_id);
      d2.close();
      if (healed.onedrive_docx_id !== STALE) break;
    }
    assert.notEqual(healed.onedrive_docx_id, STALE, 'a stale drive id was believed instead of the library');
    assert.equal(healed.onedrive_docx_id, row.onedrive_docx_id, 'the conversion record was not healed');
  });

  // The first production run marked every document done and then failed to write three of
  // them, because the template pin — which is also the "already done" marker — was written
  // at render time. A rewrite that cannot reach OneDrive must stay unfinished.
  it('does not mark a document done when the file could not be written', async () => {
    const jar = await loginAdmin();
    await new Promise((r) => setTimeout(r, 1500));

    const d = await db();
    const row = d
      .prepare(
        `SELECT c.conversion_id, v.version_id FROM conversions c
           JOIN analysis_versions v ON v.version_id = c.version_id ORDER BY c.created_at DESC LIMIT 1`,
      )
      .get();
    // An id on a drive that answers but does not hold this item: resolvable in shape, and
    // unwritable in fact, so the rewrite gets as far as OneDrive and fails there.
    d.prepare('UPDATE conversions SET onedrive_docx_id = ? WHERE conversion_id = ?').run(
      'fake-a-nonexistent',
      row.conversion_id,
    );
    d.prepare('UPDATE analysis_versions SET template_version = 0 WHERE version_id = ?').run(row.version_id);
    // Remove the library row too, so the name cannot resolve it either.
    d.prepare("UPDATE documents SET removed = 1 WHERE name LIKE '%.docx' AND path LIKE '3.%'").run();
    d.close();

    for (let i = 0; i < 3; i += 1) {
      await api('/api/library/sync', { method: 'POST', jar });
      await new Promise((r) => setTimeout(r, 1200));
    }

    const d2 = await db();
    const after = d2
      .prepare('SELECT template_version FROM analysis_versions WHERE version_id = ?')
      .get(row.version_id);
    d2.close();
    assert.equal(
      after.template_version,
      0,
      'the version was marked as carrying the letterhead although its file was never written',
    );
  });
});
