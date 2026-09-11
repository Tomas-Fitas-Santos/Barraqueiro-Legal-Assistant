#!/usr/bin/env node
// One-shot, budget-conscious live proof of the OCR + classification stages against a
// RUNNING instance whose AI is connected (Settings → ChatGPT). Usage:
//
//   node scripts/live-ocr-proof.mjs --email you@naten.ai --password '...' \
//     [--base http://localhost:3000] [--file tests/fixtures/codigo-conduta.pdf] \
//     [--data-dir data-home]
//
// Cost profile: ONE vision call per scanned page (12 for codigo-conduta) + ONE
// classification call — and every OCR'd page lands in the permanent ocr_cache, so
// re-running this script (or re-syncing the same file later) pays nothing again.
import { readFileSync } from 'node:fs';
import path from 'node:path';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = arg('base', 'http://localhost:3000');
const EMAIL = arg('email');
const PASSWORD = arg('password');
const FILE = arg('file', 'tests/fixtures/codigo-conduta.pdf');
const DATA_DIR = arg('data-dir', 'data-home');

if (!EMAIL || !PASSWORD) {
  console.error('usage: node scripts/live-ocr-proof.mjs --email <email> --password <password> [--base url] [--file pdf]');
  process.exit(2);
}

const documentId = `doc_proof_${path.basename(FILE).replace(/[^a-z0-9]/gi, '').slice(0, 20).toLowerCase()}`;

// 1) Sign in.
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const cookie = (loginRes.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
if (!loginRes.ok || !cookie) {
  console.error('login failed:', await loginRes.text());
  process.exit(1);
}
const authed = (path_, init = {}) =>
  fetch(`${BASE}${path_}`, { ...init, headers: { ...(init.headers || {}), cookie } });

// 2) AI must be connected — refuse to burn a failed run otherwise.
const status = await authed('/api/auth/openai/status').then((r) => r.json());
if (!status.authenticated) {
  console.error('AI is not connected on this instance (Settings → Connect ChatGPT). Aborting before any cost.');
  process.exit(1);
}
console.log(`AI connected as ${status.email || status.accountId || 'ChatGPT account'}.`);

// 3) Ensure a library row exists for the proof file (direct DB write — the row normally
// comes from the OneDrive delta feed, which this proof deliberately does not need).
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(path.resolve(DATA_DIR, 'legal-assistant.sqlite'));
const now = Date.now();
db.prepare(
  `INSERT OR IGNORE INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
   VALUES (?, ?, ?, '', 'application/pdf', 0, 'listed', 0, ?, ?, ?)`,
).run(documentId, `local-${documentId}`, path.basename(FILE), now, now, now);
db.close();

// 4) Upload the original → the full pipeline runs (OCR + classification, cached forever).
console.log(`Uploading ${FILE} and running the pipeline — this is the paid step…`);
const started = Date.now();
const upload = await authed(`/api/library/documents/${documentId}/original`, {
  method: 'PUT',
  headers: { 'content-type': 'application/octet-stream' },
  body: readFileSync(FILE),
}).then((r) => r.json());
if (!upload.ok) {
  console.error('pipeline failed:', upload.error);
  process.exit(1);
}
const r = upload.result;
console.log(
  `Done in ${Math.round((Date.now() - started) / 1000)}s — state ${r.state}, ${r.pageCount} page(s), ` +
    `${r.ocrDone} OCR'd now, ${r.ocrPending} pending, ${r.segments} segment(s), classified: ${r.classified}.`,
);

// 5) Show the evidence: classification + a page-anchored excerpt from an OCR'd page.
const detail = await authed(`/api/library/documents/${documentId}`).then((r2) => r2.json());
const docRow = detail.document;
console.log('\nClassification:');
console.log(`  type: ${docRow.docType} | title: ${docRow.title} | language: ${docRow.language}`);
console.log(`  topics: ${docRow.topics.join(', ')}`);
console.log(`  references found: ${docRow.references.length}`);
const ocrPage = detail.pages.find((p) => p.ocr && p.text.length > 100);
if (ocrPage) {
  console.log(`\nOCR page ${ocrPage.page} (first 400 chars):\n${ocrPage.text.slice(0, 400)}`);
} else {
  console.log('\nNo OCR page with substantial text — inspect the pages payload.');
}
console.log('\nEvery OCR result is now in ocr_cache — re-running this is free.');
