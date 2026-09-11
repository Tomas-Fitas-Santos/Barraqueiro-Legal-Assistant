import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { ApiError } from '@/app/api/_helpers';
import { aiConfigured, aiStructured, selectedModel } from '@/lib/server/ai/client';
import { CLASSIFICATION_SCHEMA, OCR_PAGE_SCHEMA } from '@/lib/server/ai/schemas';
import { genId } from '@/lib/server/crypto';
import { getDb } from '@/lib/server/db';
import { MAX_ATTACHMENT_DEPTH } from '@/lib/server/ingest/attachments';
import { resolveRendition } from '@/lib/server/ingest/renditions';
import { canReachDrive, downloadItem } from '@/lib/server/msgraph';
import { LEGAL_FILES_DIR } from '@/lib/server/paths';
import { flagPotentiallyAffected } from '@/lib/server/repo/analyses';
import { applyClassifierMetadata } from '@/lib/server/repo/document-metadata';
import { isReadableDocument } from '@/lib/library-layout';
import { getDocument, notAppManagedSql } from '@/lib/server/repo/library';
import { indexDocument, pendingIndexDocumentIds } from '@/lib/server/ingest/semantic-index';
import { sweepRelations } from '@/lib/server/repo/relations';
import { renderDocument, type DocumentStructure, type TextItem } from '@/lib/server/ingest/layout';
import type { DocumentStage } from '@/lib/types';

// The ingestion pipeline (briefing §8): SHA-256 dedup → per-page text (unpdf) → OCR for
// scanned pages (pdftoppm rasterize + one vision call per page, cached permanently by
// content hash) → classification → page-anchored segments + FTS. Everything deterministic
// runs unconditionally; the two AI stages degrade gracefully when no AI is configured and
// complete later from a re-ingest (cache-forward, so nothing is ever paid twice).

// Bumped when extraction/segmentation logic changes materially — stored per document so
// a future re-index sweep can target stale extractions (briefing §8 "versão do extrator").
export const EXTRACTOR_VERSION = '2';

/**
 * The CLASSIFICATION prompt's version. v2 asks for §7.9's semantic profile as well as §8's
 * metadata.
 *
 * Unlike OCR, a stale classification is REFRESHED automatically. The two look alike and are
 * not: OCR is a per-page vision bill across the whole corpus, while classification is one
 * cheap call per document — and its output is what the semantic index encodes, so a
 * document that never re-classifies is a document that never gets a profile, never gets a
 * meaningful vector, and is invisible to the sixth signal forever. Corrections the user made
 * by hand survive it: applyClassifierMetadata skips every overridden field.
 */
export const CLASSIFIER_VERSION = '2';

/**
 * The transcription PROMPT's version. Bumped when the prompt changes what it asks for — v2
 * asks for §7.5's structure markers, v1 asked for plain text.
 *
 * A cached page from an older version is still USED. Re-transcribing the corpus is a real
 * per-page bill, and a plain-text transcription is not wrong, only poorer — so the version
 * is here to make the staleness visible and targetable per document, never to invalidate a
 * cache behind the user's back.
 */
export const OCR_VERSION = '2';

const OCR_MIN_CHARS = 50; // a page with less extracted text than this is treated as scanned
const CLASSIFY_MAX_CHARS = 12_000; // classification reads the first pages up to this budget
const SEGMENT_TARGET_CHARS = 900;
const SEGMENT_MAX_CHARS = 1_600;

const execFileAsync = promisify(execFile);

const ORIGINALS_DIR = path.join(LEGAL_FILES_DIR, 'originals');

export function sha256Of(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function originalPath(sha256: string): string {
  return path.join(ORIGINALS_DIR, sha256);
}

/** Cheap magic-number check — the pipeline only ever reads text out of real PDFs. */
export function isPdfFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const fd = openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(4);
    readSync(fd, head, 0, 4, 0);
    return head.toString('latin1') === '%PDF';
  } finally {
    closeSync(fd);
  }
}

/**
 * The PDF a non-PDF document is read through: converted once by Graph, stored
 * content-addressed and remembered on the row. Without Graph there is nothing honest to
 * do but say so — the document stays in the library, it just cannot be cited yet.
 */
/** Store a document's original bytes content-addressed; returns the hash. Atomic write. */
export function storeOriginalBytes(bytes: Buffer): string {
  const sha = sha256Of(bytes);
  mkdirSync(ORIGINALS_DIR, { recursive: true });
  const target = originalPath(sha);
  if (!existsSync(target)) {
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, target);
  }
  return sha;
}

function normalizePageText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Deterministic paragraph splitter: blank-line paragraphs, packed to a target size. */
export function splitIntoSegments(pageText: string): string[] {
  const paragraphs = pageText
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const segments: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) segments.push(current.trim());
    current = '';
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > SEGMENT_MAX_CHARS) {
      push();
      // Oversized paragraph: split on sentence-ish boundaries, packed to the target.
      for (const piece of paragraph.split(/(?<=[.;:!?])\s+/)) {
        if (current.length + piece.length + 1 > SEGMENT_MAX_CHARS) push();
        current = current ? `${current} ${piece}` : piece;
      }
      push();
      continue;
    }
    if (current.length + paragraph.length + 2 > SEGMENT_TARGET_CHARS && current) push();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  push();
  return segments;
}

async function rasterizePage(pdfPath: string, page: number): Promise<Buffer> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'legal-ocr-'));
  try {
    const prefix = path.join(dir, 'page');
    await execFileAsync('pdftoppm', ['-png', '-r', '150', '-f', String(page), '-l', String(page), pdfPath, prefix], {
      timeout: 60_000,
    });
    const produced = readdirSync(dir).find((name) => name.endsWith('.png'));
    if (!produced) throw new Error(`pdftoppm produced no image for page ${page}`);
    return readFileSync(path.join(dir, produced));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function ocrPage(pdfPath: string, sha: string, page: number): Promise<string> {
  const image = await rasterizePage(pdfPath, page);
  const result = await aiStructured<{ page_text: string }>({
    task: 'transcribe_page',
    instructions:
      'You transcribe scanned pages of Portuguese corporate/legal documents. Transcribe ALL legible text on this page exactly as written (pt-PT), in reading order. Mark the page\'s STRUCTURE in Markdown as you go: "# "/"## " for headings, "- " for bullet items (leave legal enumerations such as "3.", "a)" or "i)" exactly as written — they are text, not bullets), GFM pipe tables for tabular content, and a blank line between paragraphs. Never repeat a running header or footer. Do not translate, summarize, correct or add anything. If the page holds no text, return an empty string.',
    groundingContract: false,
    input: [{ type: 'input_image', image_url: `data:image/png;base64,${image.toString('base64')}`, detail: 'high' }],
    schema: OCR_PAGE_SCHEMA,
    reasoningEffort: 'low',
  });
  const text = normalizePageText(result.page_text || '');
  getDb()
    .prepare(
      `INSERT INTO ocr_cache (sha256, page, text, model, ocr_version, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(sha256, page) DO UPDATE SET text = excluded.text, model = excluded.model,
                                               ocr_version = excluded.ocr_version`,
    )
    .run(sha, page, text, selectedModel(), OCR_VERSION, Date.now());
  return text;
}

type ClassificationResult = Record<string, unknown> & {
  document_type: string;
  title: string;
  topics: string[];
  references: Array<{ text: string; citation: { document_id: string; page: number; excerpt: string } }>;
  semantic_profile?: { concepts?: string[]; synonyms?: string[]; section_abstracts?: string[] };
};

async function classifyDocument(documentId: string, name: string, pages: string[]): Promise<void> {
  let budget = CLASSIFY_MAX_CHARS;
  const excerpts: string[] = [];
  for (let i = 0; i < pages.length && budget > 0; i++) {
    if (!pages[i]) continue;
    const chunk = pages[i].slice(0, budget);
    excerpts.push(`--- page ${i + 1} ---\n${chunk}`);
    budget -= chunk.length;
  }
  if (excerpts.length === 0) return;

  const result = await aiStructured<ClassificationResult>({
    task: 'classify_document',
    instructions: [
      `Classify this document from the library and extract its metadata. The document's file name is "${name}" and its id is "${documentId}".`,
      'Use ONLY what the provided pages state. Dates only if literally written in the document (ISO format), otherwise empty strings.',
      'Obligations, deadlines and cited legislation describe THIS DOCUMENT as a whole — they are its metadata, not an analysis of it. Leave a list empty rather than inferring entries.',
      `For references: list explicit mentions of OTHER documents, laws or regulations found in the text, each with a citation whose document_id is "${documentId}", the page the mention appears on, and the verbatim excerpt containing it.`,
      'For semantic_profile: describe what the document is ABOUT, not what it says. It is read by a retrieval index, never shown to a user, so prefer the vocabulary someone SEARCHING would use — both the statutory formulation and the everyday one.',
    ].join('\n'),
    input: [{ type: 'input_text', text: excerpts.join('\n\n') }],
    schema: CLASSIFICATION_SCHEMA,
    // Raised from 'low' when the semantic profile joined this call. Reading metadata off a
    // page is lookup; deciding what a document is ABOUT, and in which words a lawyer would
    // look for it, is the reasoning the whole retrieval index is then built on.
    reasoningEffort: 'medium',
  });

  // Not a blanket column write: fields the user corrected by hand are left alone, which is
  // what stops a re-ingest silently undoing their answer.
  applyClassifierMetadata(documentId, result);

  getDb()
    .prepare('UPDATE documents SET classifier_version = ? WHERE document_id = ?')
    .run(CLASSIFIER_VERSION, documentId);

  // Written outside applyClassifierMetadata: this is not a §8 metadata field, it is never
  // shown and there is nothing for a user to correct.
  getDb()
    .prepare('UPDATE documents SET semantic_profile_json = ? WHERE document_id = ?')
    .run(
      JSON.stringify({
        concepts: result.semantic_profile?.concepts || [],
        synonyms: result.semantic_profile?.synonyms || [],
        sectionAbstracts: result.semantic_profile?.section_abstracts || [],
      }),
      documentId,
    );
}

export type IngestResult = {
  documentId: string;
  skipped: boolean;
  state: string;
  pageCount: number;
  ocrDone: number;
  ocrPending: number;
  segments: number;
  /** Segments the local encoder vectorised — 0 when the encoder is unavailable. */
  embedded: number;
  classified: boolean;
  detail: string;
  /** Documents created from inside this one — an e-mail's attachments. */
  extracted: number;
};

export type IngestOptions = {
  force?: boolean;
  stagedSha?: string;
  depth?: number;
  /** Throw away transcriptions made by an older prompt and pay for them again. Never implicit. */
  reocr?: boolean;
};

/**
 * Pages of this document whose transcription came from an older prompt than the current one.
 * They are perfectly readable — this is what lets the app OFFER a re-transcription for a
 * document instead of quietly re-billing the whole corpus.
 */
export function staleOcrPages(documentId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM document_pages p
         JOIN documents d ON d.document_id = p.document_id
         JOIN ocr_cache c ON c.sha256 = d.sha256 AND c.page = p.page
        WHERE p.document_id = ? AND p.ocr = 1 AND c.ocr_version <> ?`,
    )
    .get(documentId, OCR_VERSION) as { n: number };
  return Number(row?.n || 0);
}

/**
 * The coarse pipeline state and §6's fine stage move together, always — a stage left behind
 * by the previous run is what would make a finished document still say "Em OCR".
 */
function setState(documentId: string, state: string, stage: DocumentStage, detail: string): void {
  getDb()
    .prepare('UPDATE documents SET state = ?, stage = ?, state_detail = ?, updated_at = ? WHERE document_id = ?')
    .run(state, stage, detail, Date.now(), documentId);
}

let ingestChain: Promise<unknown> = Promise.resolve();

/** Serialize ingests — the pipeline is IO/CPU heavy and SQLite writes prefer one writer. */
export function queueIngest<T>(work: () => Promise<T>): Promise<T> {
  const next = ingestChain.then(work, work);
  ingestChain = next.catch(() => undefined);
  return next;
}

export async function ingestDocument(documentId: string, options?: IngestOptions): Promise<IngestResult> {
  const result = await queueIngest(() => runIngest(documentId, options));
  // Attachments are ingested AFTER this document's slot in the queue is released. Awaiting
  // them inside runIngest would make the serial chain wait on work that waits on the chain
  // — a deadlock, and a permanent one.
  if (result.extracted > 0) ingestPendingInBackground();
  return result;
}

async function runIngest(documentId: string, options?: IngestOptions): Promise<IngestResult> {
  const doc = getDocument(documentId);
  if (!doc) throw new ApiError('Document not found.', 404);
  const db = getDb();
  let extractedIds: string[] = [];

  // Bytes: an explicitly staged original wins (the upload door), then the stored local
  // original, then a Graph download. The PIPELINE owns the sha stamp and the content-
  // change consequences — callers never pre-write documents.sha256.
  const stored = db.prepare('SELECT sha256, classifier_version FROM documents WHERE document_id = ?').get(documentId) as {
    sha256: string;
    classifier_version: string;
  };
  let sha = String(stored?.sha256 || '');
  let pdfPath = sha ? originalPath(sha) : '';
  if (options?.stagedSha && existsSync(originalPath(options.stagedSha))) {
    sha = options.stagedSha;
    pdfPath = originalPath(sha);
  } else if (!sha || !existsSync(pdfPath)) {
    if (!canReachDrive()) {
      throw new ApiError('No local original and the Microsoft account is not connected.', 400);
    }
    const res = await downloadItem(doc.driveItemId);
    const bytes = Buffer.from(await res.arrayBuffer());
    sha = storeOriginalBytes(bytes);
    pdfPath = originalPath(sha);
  }

  const shaChanged = sha !== String(stored?.sha256 || '');

  // Files the APP manages are not documents to be read: a template is a stencil, and a
  // generated DOCX/PDF/JSON is this app's own output coming back through the delta feed.
  // Indexing them would ask Graph to convert a JSON to PDF — one permanently failed row per
  // analysis — and spend an OCR pass and a classification call on a template. Their content
  // hash is still recorded, because the templates registry identifies files by it.
  if (!isReadableDocument(doc.path)) {
    // The preview rendition is keyed to the CONTENT that produced it, so a template whose
    // bytes have moved on must drop the pointer to the old one — otherwise "Pré-visualizar"
    // keeps showing the previous edition of a file the client has already changed.
    if (shaChanged) {
      db.prepare("UPDATE documents SET text_sha256 = '' WHERE document_id = ?").run(documentId);
    }
    db.prepare('UPDATE documents SET sha256 = ?, updated_at = ? WHERE document_id = ?').run(sha, Date.now(), documentId);
    setState(documentId, 'listed', 'recebido', 'Ficheiro da aplicação (template ou documento gerado) — não é indexado.');
    return {
      documentId,
      skipped: true,
      state: 'listed',
      pageCount: 0,
      ocrDone: 0,
      ocrPending: 0,
      segments: 0,
      embedded: 0,
      classified: false,
      extracted: 0,
      detail: 'App-managed file; not indexed.',
    };
  }

  // Dedup skips only a FULLY settled document: same content, indexed, no pages still
  // awaiting OCR (an indexed-with-alert doc must re-run once AI becomes available), and
  // classified by the CURRENT prompt — a document carrying a v1 classification has no
  // semantic profile, so skipping it here is what would leave it permanently unindexable.
  const pendingPages = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM document_pages WHERE document_id = ? AND pending_ocr = 1').get(documentId) as {
      n: number;
    }).n,
  );
  const staleClassification =
    String(stored?.classifier_version || '1') !== CLASSIFIER_VERSION && (await aiConfigured());
  if (!options?.force && !shaChanged && doc.state === 'indexed' && pendingPages === 0 && !staleClassification) {
    return {
      documentId,
      skipped: true,
      state: 'indexed',
      pageCount: 0,
      ocrDone: 0,
      ocrPending: 0,
      segments: 0,
      embedded: 0,
      classified: false,
      extracted: 0,
      detail: 'Unchanged content already indexed.',
    };
  }
  const hadContentBefore = Boolean(stored?.sha256);
  if (shaChanged) {
    // text_sha256 is cleared too: it points at the rendition of the PREVIOUS contents, and
    // leaving it behind is how an edited DOCX kept being read from its old PDF.
    db.prepare(
      "UPDATE documents SET sha256 = ?, text_sha256 = '', classified_at = 0, updated_at = ? WHERE document_id = ?",
    ).run(sha, Date.now(), documentId);
    // §15: a changed document flags (never regenerates) the analyses that used it.
    if (hadContentBefore) flagPotentiallyAffected(documentId, 'content_changed');
  }

  setState(documentId, 'processing', 'em_extracao', 'Em extração');
  try {
    // The library takes any kind of document, but pages, excerpts and citations are only
    // defined on a PDF — so every other format is READ THROUGH a PDF rendition the app
    // builds for it. The original is never replaced.
    const rendition = await resolveRendition({
      documentId,
      driveItemId: doc.driveItemId,
      name: doc.name,
      path: doc.path,
      mime: doc.mime,
      originalFile: pdfPath,
      sourceSha: sha,
      depth: options?.depth || 0,
    });
    pdfPath = rendition.pdfPath;
    extractedIds = rendition.extractedDocumentIds;

    // Per-page text extraction — unless the app GENERATED this PDF, in which case it
    // already knows what is on every page and reading it back could only lose fidelity.
    let pageTexts: string[];
    let structure: DocumentStructure | null = null;
    if (rendition.pageTexts) {
      pageTexts = rendition.pageTexts.map(normalizePageText);
    } else {
      // unpdf wants a Uint8Array; import lazily so the module never loads for requests
      // that don't ingest. The ITEMS, not the flat text: §7.5's structure is in where the
      // runs sit and how big they are, and extractText() throws exactly that away.
      const { extractTextItems, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(readFileSync(pdfPath)));
      const { items } = await extractTextItems(pdf);
      structure = renderDocument(items as TextItem[][]);
      pageTexts = structure.pages.map(normalizePageText);
    }

    const canOcr = await aiConfigured();
    // Asked for explicitly, and only then: dropping these rows is what makes the next loop
    // pay the vision bill again for pages that already have a usable transcription.
    if (options?.reocr) {
      db.prepare('DELETE FROM ocr_cache WHERE sha256 = ? AND ocr_version <> ?').run(sha, OCR_VERSION);
    }
    let ocrDone = 0;
    let ocrPending = 0;
    const finalPages: Array<{ text: string; ocr: boolean; pending: boolean }> = [];

    for (let i = 0; i < pageTexts.length; i++) {
      // Text the app wrote is never "thin" — it is exactly what it is.
      if (rendition.authoritative) {
        finalPages.push({ text: pageTexts[i], ocr: false, pending: false });
        continue;
      }
      const page = i + 1;
      if (pageTexts[i].length >= OCR_MIN_CHARS) {
        finalPages.push({ text: pageTexts[i], ocr: false, pending: false });
        continue;
      }
      const cached = db.prepare('SELECT text FROM ocr_cache WHERE sha256 = ? AND page = ?').get(sha, page) as
        | { text: string }
        | undefined;
      if (cached) {
        finalPages.push({ text: cached.text, ocr: true, pending: false });
        continue;
      }
      if (canOcr) {
        setState(documentId, 'processing', 'em_ocr', `Em OCR — página ${page} de ${pageTexts.length}`);
        const text = await ocrPage(pdfPath, sha, page);
        ocrDone += 1;
        finalPages.push({ text, ocr: true, pending: false });
      } else {
        ocrPending += 1;
        finalPages.push({ text: '', ocr: false, pending: true });
      }
    }

    // Persist pages + rebuild segments in one transaction (FTS follows via triggers).
    // The try/ROLLBACK covers ONLY the transaction — an error in the stages after COMMIT
    // must surface itself, not a bogus "cannot rollback" that masks it.
    const now = Date.now();
    let segmentCount = 0;
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM document_pages WHERE document_id = ?').run(documentId);
      const insertPage = db.prepare(
        'INSERT INTO document_pages (document_id, page, text, ocr, pending_ocr, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      finalPages.forEach((p, i) => insertPage.run(documentId, i + 1, p.text, p.ocr ? 1 : 0, p.pending ? 1 : 0, now));

      db.prepare('DELETE FROM segments WHERE document_id = ?').run(documentId);
      const insertSegment = db.prepare(
        'INSERT INTO segments (segment_id, document_id, page, seq, text) VALUES (?, ?, ?, ?, ?)',
      );
      finalPages.forEach((p, i) => {
        if (!p.text) return;
        splitIntoSegments(p.text).forEach((text, seq) => {
          insertSegment.run(genId('seg'), documentId, i + 1, seq, text);
          segmentCount += 1;
        });
      });
      db.prepare('UPDATE documents SET page_count = ?, updated_at = ? WHERE document_id = ?').run(
        finalPages.length,
        now,
        documentId,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    // Classification: once per content hash AND per prompt version, only with text and a
    // configured AI.
    const classifiedRow = db
      .prepare('SELECT classified_at, classifier_version FROM documents WHERE document_id = ?')
      .get(documentId) as { classified_at: number; classifier_version: string };
    const alreadyClassified =
      Number(classifiedRow.classified_at) > 0 && String(classifiedRow.classifier_version) === CLASSIFIER_VERSION;
    let classified = false;
    if (!alreadyClassified && canOcr && finalPages.some((p) => p.text)) {
      setState(documentId, 'processing', 'em_classificacao', 'Em classificação');
      await classifyDocument(documentId, doc.name, finalPages.map((p) => p.text));
      classified = true;
      // §15: a NEW document that references an analysis's main document flags it.
      if (!hadContentBefore) flagPotentiallyAffected(documentId, 'new_document');
    }

    // §7.9: the semantic index is built HERE, during processing, after classification so it
    // can encode the model's account of what the document is about. Outside the transaction,
    // and never allowed to fail the ingest: a document whose text is stored and searchable is
    // successfully processed even if the encoder is missing — it just loses the sixth signal.
    let embedded = 0;
    try {
      embedded = (await indexDocument(documentId)).encoded;
    } catch (error) {
      console.error('[ingest] semantic index failed for', documentId, error);
    }

    // §7 step 10: this document's relations — and every other document's, since a newcomer
    // changes what the existing ones are closest to — are now uncompared. Nothing is marked:
    // finishing this document changed its fingerprint, which is what makes its pairs
    // uncovered, so the ledger already knows. The recomputation is deliberately NOT done
    // here — it runs once when the ingest queue drains, so a 500-file sync produces one pass
    // instead of five hundred. When this ingest IS the sweep the running guard makes this a
    // no-op; when it is a lone upload, this is what makes its relations ready by the time
    // anyone opens it.
    ingestPendingInBackground();

    // Deterministic provenance (briefing §8): extractor version + a coarse OCR-quality
    // verdict derived from what the OCR path actually produced.
    const ocrPagesWithText = finalPages.filter((p) => p.ocr && p.text.length >= 100).length;
    const ocrPagesTotal = finalPages.filter((p) => p.ocr).length + ocrPending;
    const ocrQuality = ocrPagesTotal === 0 ? 'n/a' : ocrPending > 0 ? 'pendente' : ocrPagesWithText === ocrPagesTotal ? 'boa' : 'parcial';
    db.prepare(
      'UPDATE documents SET extractor_version = ?, ocr_quality = ?, structure_json = ?, updated_at = ? WHERE document_id = ?',
    ).run(
      EXTRACTOR_VERSION,
      ocrQuality,
      JSON.stringify(
        structure || { headings: 0, lists: 0, tables: 0, tableConfidence: 'n/a' as const },
        (key, value) => (key === 'pages' ? undefined : value),
      ),
      Date.now(),
      documentId,
    );

    // Briefing §6: a document with pending-OCR pages is INDEXED (its text-layer pages are
    // searchable) with an OCR alert — not stuck in a pre-indexed state.
    const detail =
      ocrPending > 0
        ? `Alerta de OCR: ${ocrPending} página(s) por transcrever — ligue a AI em Settings e reprocesse.`
        : !alreadyClassified && !classified
          ? 'Classificação pendente (AI não configurada).'
          : '';
    setState(documentId, 'indexed', 'indexado', detail);

    return {
      documentId,
      skipped: false,
      state: 'indexed',
      pageCount: finalPages.length,
      ocrDone,
      ocrPending,
      segments: segmentCount,
      embedded,
      classified,
      extracted: extractedIds.length,
      detail,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setState(documentId, 'failed', 'erro', message.slice(0, 300));
    throw error;
  }
}

let sweepRunning = false;

/** One backfill pass indexes at most this many documents, in chunks, then yields the sweep. */
const BACKFILL_CHUNK = 10;
const BACKFILL_BATCHES = 20;

/** Background sweep after a sync: ingest every listed (never-processed) document. */
/** How deep inside other documents this one was found — an e-mail chain has a bottom. */
function depthOf(documentId: string): number {
  let depth = 0;
  let current = documentId;
  for (let i = 0; i < MAX_ATTACHMENT_DEPTH + 1; i += 1) {
    const row = getDb()
      .prepare('SELECT parent_document_id FROM documents WHERE document_id = ?')
      .get(current) as { parent_document_id?: string } | undefined;
    const parent = String(row?.parent_document_id || '');
    if (!parent) break;
    depth += 1;
    current = parent;
  }
  return depth;
}

export function ingestPendingInBackground(): void {
  if (sweepRunning) return;
  sweepRunning = true;
  void (async () => {
    try {
      // New documents always; a document indexed with an OCR alert, or carrying an older
      // classification, only when the AI is available to actually redo it.
      const canOcr = await aiConfigured();
      const notAppManaged = notAppManagedSql();
      const rows = getDb()
        .prepare(
          `SELECT d.document_id FROM documents d WHERE d.removed = 0 AND ${notAppManaged.sql} AND (
             d.state = 'listed'
             ${'' /* pending-OCR follow-up */}
             OR (? = 1 AND d.state = 'indexed' AND EXISTS (
               SELECT 1 FROM document_pages p WHERE p.document_id = d.document_id AND p.pending_ocr = 1
             ))
             OR (? = 1 AND d.state = 'indexed' AND d.classifier_version <> ?)
           )`,
        )
        // The app-managed placeholders appear first in the text, so they bind first.
        .all(...notAppManaged.params, canOcr ? 1 : 0, canOcr ? 1 : 0, CLASSIFIER_VERSION) as Array<{
        document_id: string;
      }>;
      for (const row of rows) {
        try {
          await ingestDocument(row.document_id, { depth: depthOf(row.document_id) });
        } catch (error) {
          console.warn(
            `[legal] Background ingest of ${row.document_id} failed:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
      // Then the documents that were processed before the semantic index existed. Chunked
      // and resumable BY CONSTRUCTION: the query asks for documents that have segments and
      // no vector, so a container restart mid-backfill simply resumes where it stopped, and
      // a finished corpus makes the query return nothing.
      for (let batch = 0; batch < BACKFILL_BATCHES; batch += 1) {
        const pending = pendingIndexDocumentIds(BACKFILL_CHUNK);
        if (pending.length === 0) break;
        for (const documentId of pending) {
          try {
            await indexDocument(documentId);
          } catch (error) {
            console.warn(
              `[legal] Semantic index of ${documentId} failed:`,
              error instanceof Error ? error.message : error,
            );
            // Leave the vector NULL and stop the backfill: if the encoder is missing, every
            // remaining document would fail the same way and log the same line 500 times.
            return;
          }
        }
      }

      // The queue has drained. THIS is where relations are computed — once, over everything
      // the sync touched, with the whole library's vectors read a single time.
      await sweepRelations();
    } finally {
      sweepRunning = false;
    }
  })();
}
