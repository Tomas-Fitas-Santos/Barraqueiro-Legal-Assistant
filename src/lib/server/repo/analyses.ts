import { ApiError } from '@/app/api/_helpers';
import { aiConfigured, aiStructured } from '@/lib/server/ai/client';
import { revisionMatrixSchema, summaryExtractionSchema } from '@/lib/server/ai/schemas';
import { NOT_CONFIRMED_SENTENCE } from '@/lib/server/ai/contract';
import { validateAnalysisItem, type SourcedItem } from '@/lib/server/analysis-rules';
import { genId } from '@/lib/server/crypto';
import { getDb } from '@/lib/server/db';
import { cosine } from '@/lib/server/ingest/embed';
import { excerptOnPage, listPages } from '@/lib/server/ingest/pages';
import { embedSubject, segmentVectors } from '@/lib/server/ingest/semantic-index';
import { isReadableDocument } from '@/lib/library-layout';
import { extractionFields, type ExtractionField } from '@/lib/server/repo/extraction-template';
import { getDocumentDetail, type DocumentDetail } from '@/lib/server/repo/library';
import {
  listExtractions,
  markExtractionApproved,
  markExtractionRejected,
  pendingLegalDecisions,
  storeExtraction,
} from '@/lib/server/repo/extractions';
import { listRelations, manualConfidence, proposeRelations, storedConfidence } from '@/lib/server/repo/relations';
import { isRelevance, type AnalysisState, type AnalysisType, type Relevance } from '@/lib/types';
import { msg } from '@/lib/workflow/messages';

// The analyses core (briefing §5/§6/§10/§11): state machine, per-document confirmation
// gates, the two structured run stages, and the app-side citation validators. Every step
// appends to analysis_events — the Histórico requirement (§5.5).

const RUN_PAGE_CHAR_BUDGET = 60_000; // per document fed to a run stage

export type AnalysisRow = {
  analysisId: string;
  type: AnalysisType;
  mainDocumentId: string;
  mainDocumentName: string;
  state: AnalysisState;
  stateDetail: string;
  potentiallyAffected: boolean;
  affectedReason: string;
  instructions: string;
  templateOverride: string;
  itemCount: number;
  /**
   * A file this analysis rests on is not reachable in the library right now. DERIVED, never
   * stored: the analysis un-archives by itself the moment the file comes back, so nothing
   * has to remember to repair it.
   */
  archived: boolean;
  /** Set when the e-mail was approved: the analysis is concluded and read-only. */
  closedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type DbAnalysisRow = {
  analysis_id: string;
  closed_at: number | null;
  type: AnalysisType;
  main_document_id: string;
  main_name: string;
  missing_count: number;
  state: AnalysisState;
  state_detail: string;
  potentially_affected: number;
  affected_reason: string;
  instructions: string;
  template_override: string;
  item_count: number;
  created_at: number;
  updated_at: number;
};

function toRow(row: DbAnalysisRow): AnalysisRow {
  return {
    analysisId: row.analysis_id,
    type: row.type,
    mainDocumentId: row.main_document_id,
    mainDocumentName: row.main_name,
    state: row.state,
    stateDetail: row.state_detail,
    potentiallyAffected: Boolean(row.potentially_affected),
    affectedReason: row.affected_reason,
    closedAt: row.closed_at ?? null,
    instructions: row.instructions,
    templateOverride: row.template_override,
    itemCount: row.item_count,
    archived: row.missing_count > 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ROW_SQL = `
  SELECT a.*, d.name AS main_name,
         (SELECT COUNT(*) FROM analysis_items i WHERE i.analysis_id = a.analysis_id AND i.accepted = 1) AS item_count,
         (SELECT COUNT(*) FROM analysis_documents ad
            JOIN documents md ON md.document_id = ad.document_id
           WHERE ad.analysis_id = a.analysis_id AND ad.status <> 'excluded' AND md.missing = 1)
           + (CASE WHEN d.missing = 1 THEN 1 ELSE 0 END) AS missing_count
  FROM analyses a JOIN documents d ON d.document_id = a.main_document_id`;

/** The files an archived analysis is waiting for — what the banner has to be able to name. */
export function missingDocumentsFor(analysisId: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT md.name FROM analysis_documents ad
         JOIN documents md ON md.document_id = ad.document_id
        WHERE ad.analysis_id = ? AND ad.status <> 'excluded' AND md.missing = 1
       UNION
       SELECT d.name FROM analyses a JOIN documents d ON d.document_id = a.main_document_id
        WHERE a.analysis_id = ? AND d.missing = 1
       ORDER BY 1`,
    )
    .all(analysisId, analysisId) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * The guidance in force on a path: what the analysis was created with, plus every revert
 * answer along this path's own lineage — and nothing from a sibling path.
 */
export function effectiveGuidance(analysisId: string, lineage: string[]): string {
  const analysis = getAnalysis(analysisId);
  const rows = getDb()
    .prepare('SELECT letter, guidance FROM analysis_paths WHERE analysis_id = ?')
    .all(analysisId) as Array<{ letter: string; guidance: string }>;
  const byLetter = new Map(rows.map((row) => [row.letter, row.guidance]));
  // Oldest ancestor first, so the answers read in the order they were given.
  const chain = [...lineage].reverse().map((letter) => byLetter.get(letter) || '');
  return [analysis?.instructions || '', ...chain].filter(Boolean).join('\n');
}

/**
 * A concluded analysis is read-only. The refusal is the definition's own sentence, so the
 * API says exactly what the UI says when it disables the button.
 */
export function assertNotClosed(analysisId: string): void {
  const row = getDb().prepare('SELECT closed_at FROM analyses WHERE analysis_id = ?').get(analysisId) as
    | { closed_at: number | null }
    | undefined;
  if (row?.closed_at) throw new ApiError(msg('block.closed'), 409);
}

/**
 * Run an operation with the analysis marked busy, so the UI can say what is happening and
 * refuse a second start. Cleared however the operation ends — a crash leaves the marker
 * behind on purpose, which is what boot_epoch then recognises as interrupted.
 */
export async function withBusy<T>(analysisId: string, action: string, work: () => Promise<T>): Promise<T> {
  const db = getDb();
  db.prepare('UPDATE analyses SET busy_action = ?, busy_started_at = ? WHERE analysis_id = ?').run(
    action,
    Date.now(),
    analysisId,
  );
  try {
    return await work();
  } finally {
    db.prepare("UPDATE analyses SET busy_action = '', busy_started_at = 0 WHERE analysis_id = ?").run(analysisId);
  }
}

/**
 * The single failure contract. Every operation that can fail does these three things and
 * no others: park the analysis in `erro` with the detail, record ONE `error` event naming
 * the step it failed in, and throw an ApiError carrying a sentence the user can read.
 *
 * The last part is the change that matters. These were plain Errors, so `jsonError` turned
 * them into `{"error":"Internal error."}` while the real message survived only in
 * state_detail — the user was told nothing and the log was the only place to look.
 */
function failOperation(analysisId: string, step: string, phaseLabel: string, error: unknown): ApiError {
  const detail = error instanceof Error ? error.message : String(error);
  setAnalysisState(analysisId, 'erro', detail.slice(0, 300));
  recordEvent(analysisId, 'error', { step, message: detail.slice(0, 500) });
  return new ApiError(msg('error.failed', { phase: phaseLabel, detail: detail.slice(0, 200) }), 502);
}

/** The active path and its ancestors, newest first. */
function guidanceLineage(analysisId: string): string[] {
  const db = getDb();
  const paths = db
    .prepare('SELECT letter, parent_version_id FROM analysis_paths WHERE analysis_id = ?')
    .all(analysisId) as Array<{ letter: string; parent_version_id: string }>;
  const byLetter = new Map(paths.map((p) => [p.letter, p]));
  const versions = db
    .prepare('SELECT version_id, path_letter FROM analysis_versions WHERE analysis_id = ?')
    .all(analysisId) as Array<{ version_id: string; path_letter: string }>;
  const versionPath = new Map(versions.map((v) => [v.version_id, v.path_letter]));

  const order: string[] = [];
  let current = byLetter.get(activePath(analysisId));
  let hops = 0;
  while (current && hops < 27) {
    order.push(current.letter);
    const parentLetter = current.parent_version_id ? versionPath.get(current.parent_version_id) : undefined;
    if (!parentLetter) break;
    current = byLetter.get(parentLetter);
    hops += 1;
  }
  return order;
}

/** The path being worked on. Read here rather than imported: versions.ts imports THIS
 *  module, so taking activePath() from it would close an import cycle. */
function activePath(analysisId: string): string {
  const row = getDb().prepare('SELECT active_path FROM analyses WHERE analysis_id = ?').get(analysisId) as
    | { active_path: string }
    | undefined;
  return row?.active_path || 'a';
}

export function recordEvent(analysisId: string, kind: string, detail: Record<string, unknown> = {}): void {
  // The path is stamped HERE, from the analysis's own active path, so no reader ever has
  // to guess which path a step belonged to. A fork updates active_path before recording
  // its own event, which is what makes that event the first step of the new path.
  const row = getDb().prepare('SELECT active_path FROM analyses WHERE analysis_id = ?').get(analysisId) as
    | { active_path: string }
    | undefined;
  getDb()
    .prepare(
      `INSERT INTO analysis_events (event_id, analysis_id, kind, detail_json, path_letter, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(genId('evt'), analysisId, kind, JSON.stringify(detail), row?.active_path || 'a', Date.now());
}

function setAnalysisState(analysisId: string, state: AnalysisState, detail = ''): void {
  getDb()
    .prepare('UPDATE analyses SET state = ?, state_detail = ?, updated_at = ? WHERE analysis_id = ?')
    .run(state, detail, Date.now(), analysisId);
}

export function getAnalysis(analysisId: string): AnalysisRow | null {
  const row = getDb().prepare(`${ROW_SQL} WHERE a.analysis_id = ?`).get(analysisId) as DbAnalysisRow | undefined;
  return row ? toRow(row) : null;
}

function requireAnalysis(analysisId: string): AnalysisRow {
  const analysis = getAnalysis(analysisId);
  if (!analysis || analysis.state === 'eliminada') throw new ApiError('Analysis not found.', 404);
  return analysis;
}

export function listAnalyses(): AnalysisRow[] {
  const rows = getDb()
    .prepare(`${ROW_SQL} WHERE a.state != 'eliminada' ORDER BY a.updated_at DESC`)
    .all() as DbAnalysisRow[];
  return rows.map(toRow);
}

export type DocumentAnalysisRow = AnalysisRow & {
  /** How this document took part: the subject of the analysis, or source material for it. */
  role: 'main' | 'related';
  status: 'pending' | 'confirmed' | 'excluded';
  /** The DOCX/PDF/JSON each run produced, so the detail page can open them directly. */
  outputs: Array<{
    conversionId: string;
    versionId: string;
    pdfFilename: string;
    state: string;
    approvedAt: number | null;
    /**
     * The generated file's own row in the library, when it is still there. Empty when the
     * run never reached OneDrive, or when the file has since been deleted — the analysis
     * still happened, so the output is listed either way, just not as a link.
     */
    documentId: string;
  }>;
};

/**
 * Every analysis that used this document, with what each one produced.
 *
 * The reverse of the lookup the app has always done. `analysis_documents`' primary key is
 * `(analysis_id, document_id)`, so asking it the other way round was a full scan until
 * `idx_analysis_documents_doc` existed.
 */
export function listAnalysesForDocument(documentId: string): DocumentAnalysisRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ad.analysis_id, ad.role, ad.status FROM analysis_documents ad
         JOIN analyses a ON a.analysis_id = ad.analysis_id
        WHERE ad.document_id = ? AND a.state != 'eliminada'
        ORDER BY a.updated_at DESC`,
    )
    .all(documentId) as Array<{ analysis_id: string; role: 'main' | 'related'; status: 'pending' | 'confirmed' | 'excluded' }>;
  // The generated file is joined by OneDrive item id — the same identity
  // `analysisOfGeneratedDocument` uses in the opposite direction — preferring the PDF,
  // which is what the row names, and falling back to the DOCX when no PDF was produced.
  const outputsFor = db.prepare(
    `SELECT c.conversion_id, c.version_id, c.pdf_filename, c.state, c.approved_at,
            COALESCE(pdf.document_id, docx.document_id, '') AS document_id
       FROM conversions c
       LEFT JOIN documents pdf
              ON pdf.removed = 0 AND c.onedrive_pdf_id != '' AND pdf.drive_item_id = c.onedrive_pdf_id
       LEFT JOIN documents docx
              ON docx.removed = 0 AND c.onedrive_docx_id != '' AND docx.drive_item_id = c.onedrive_docx_id
      WHERE c.analysis_id = ? ORDER BY c.created_at`,
  );
  const result: DocumentAnalysisRow[] = [];
  for (const row of rows) {
    const analysis = getAnalysis(row.analysis_id);
    if (!analysis) continue;
    const outputs = outputsFor.all(row.analysis_id) as Array<{
      conversion_id: string;
      version_id: string;
      pdf_filename: string;
      state: string;
      approved_at: number | null;
      document_id: string;
    }>;
    result.push({
      ...analysis,
      role: row.role,
      status: row.status,
      outputs: outputs.map((o) => ({
        conversionId: o.conversion_id,
        versionId: o.version_id,
        pdfFilename: o.pdf_filename,
        state: o.state,
        approvedAt: o.approved_at,
        documentId: String(o.document_id || ''),
      })),
    });
  }
  return result;
}

/**
 * The analysis a GENERATED document came out of, if this document is one.
 *
 * Joined on the OneDrive item id, which is UNIQUE on both sides and is literally the same
 * file, falling back to the content hash. NOT on the folder name: `analysisFolderName()`
 * truncates the analysis id to six characters, so parsing it back is guesswork.
 */
export function analysisOfGeneratedDocument(
  driveItemId: string,
  sha256: string,
): { analysisId: string; conversionId: string; versionId: string; type: AnalysisType; mainDocumentName: string; versionLabel: string; approvalState: string } | null {
  const row = getDb()
    .prepare(
      `SELECT c.analysis_id, c.conversion_id, c.version_id, c.state AS approval_state,
              a.type, d.name AS main_document_name,
              ('v' || v.path_seq || v.path_letter) AS version_label
         FROM conversions c
         JOIN analyses a ON a.analysis_id = c.analysis_id
         JOIN documents d ON d.document_id = a.main_document_id
         JOIN analysis_versions v ON v.version_id = c.version_id
        WHERE (c.onedrive_pdf_id != '' AND c.onedrive_pdf_id = ?)
           OR (c.onedrive_docx_id != '' AND c.onedrive_docx_id = ?)
           OR (c.onedrive_json_id != '' AND c.onedrive_json_id = ?)
           OR (? != '' AND (c.pdf_sha256 = ? OR c.docx_sha256 = ?))
        LIMIT 1`,
    )
    .get(driveItemId, driveItemId, driveItemId, sha256, sha256, sha256) as
    | { analysis_id: string; conversion_id: string; version_id: string; type: AnalysisType; main_document_name: string; version_label: string; approval_state: string }
    | undefined;
  return row ? {
    analysisId: row.analysis_id,
    conversionId: row.conversion_id,
    versionId: row.version_id,
    type: row.type,
    mainDocumentName: row.main_document_name,
    versionLabel: row.version_label,
    approvalState: row.approval_state,
  } : null;
}

// --- Creation + document set ----------------------------------------------

export function createAnalysis(
  type: AnalysisType,
  mainDocumentId: string,
  options?: { relatedDocumentIds?: string[]; templateId?: string; instructions?: string },
): AnalysisRow {
  const main = getDocumentDetail(mainDocumentId);
  if (!main) throw new ApiError('Main document not found.', 404);
  if (main.state !== 'indexed') throw new ApiError('The main document is not indexed yet.', 400);

  const db = getDb();
  const analysisId = genId('ana');
  const now = Date.now();
  db.prepare(
    `INSERT INTO analyses (analysis_id, type, main_document_id, state, instructions, template_override, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    analysisId,
    type,
    mainDocumentId,
    'rascunho',
    String(options?.instructions || '').slice(0, 4000),
    String(options?.templateId || ''),
    now,
    now,
  );
  // Every analysis starts on path "a" (fork model, phase 9).
  db.prepare(
    "INSERT INTO analysis_paths (analysis_id, letter, parent_version_id, created_at) VALUES (?, 'a', '', ?)",
  ).run(analysisId, now);
  // The main document is part of the set, always confirmed — it is the analysis's object.
  db.prepare(
    `INSERT INTO analysis_documents (analysis_id, document_id, role, status, decided_at) VALUES (?, ?, 'main', 'confirmed', ?)`,
  ).run(analysisId, mainDocumentId, now);
  // Related documents picked at setup are an explicit human choice — born CONFIRMED
  // (the identify-relations step can still propose more for revisions).
  for (const relatedId of options?.relatedDocumentIds || []) {
    if (relatedId === mainDocumentId) continue;
    const related = getDocumentDetail(relatedId);
    if (!related || related.state !== 'indexed') continue;
    db.prepare(
      `INSERT OR IGNORE INTO analysis_documents (analysis_id, document_id, role, status, relation_type, decided_at)
       VALUES (?, ?, 'related', 'confirmed', 'selecionado_no_assistente', ?)`,
    ).run(analysisId, relatedId, now);
  }
  recordEvent(analysisId, 'created', {
    type,
    mainDocumentId,
    mainDocumentName: main.name,
    relatedSelected: (options?.relatedDocumentIds || []).length,
    hasInstructions: Boolean(options?.instructions),
  });
  return requireAnalysis(analysisId);
}

export type AnalysisDocumentRow = {
  documentId: string;
  documentName: string;
  role: 'main' | 'related';
  status: 'pending' | 'confirmed' | 'excluded';
  relationType: string;
  decidedAt: number | null;
  /**
   * §5.3's six fields. The gate asks the user to confirm each related document
   * INDIVIDUALLY, and a name plus a relation type is not enough to decide with — these are
   * what the decision is actually made on.
   */
  versionLabel: string;
  issuedDate: string;
  relevance: Relevance | '';
  /**
   * Whether the app can show the link is real at all — the question relevância does not
   * answer. A document can be highly relevant AND rest on nothing but similarity, and §5.3
   * asks the user to decide, so both have to be on the row being decided.
   */
  confidence: { level: string; basis: string };
  reason: string;
  excerpts: Array<{ documentId: string; page: number; text: string }>;
};

export function listAnalysisDocuments(analysisId: string): AnalysisDocumentRow[] {
  const rows = getDb()
    .prepare(
      `SELECT ad.*, d.name, d.version_label, d.issued_date, r.evidence_json
         FROM analysis_documents ad
         JOIN documents d ON d.document_id = ad.document_id
         LEFT JOIN relations r ON r.relation_id = ad.relation_id
        WHERE ad.analysis_id = ? ORDER BY ad.role = 'main' DESC, d.name`,
    )
    .all(analysisId) as Array<{
    document_id: string;
    name: string;
    version_label: string;
    issued_date: string;
    evidence_json: string | null;
    role: 'main' | 'related';
    status: 'pending' | 'confirmed' | 'excluded';
    relation_type: string;
    decided_at: number | null;
  }>;
  return rows.map((row) => {
    const { relevance, confidence, reason, excerpts } = relationEvidence(row.evidence_json);
    return {
      documentId: row.document_id,
      documentName: row.name,
      role: row.role,
      status: row.status,
      relationType: row.relation_type,
      decidedAt: row.decided_at,
      versionLabel: row.version_label || '',
      issuedDate: row.issued_date || '',
      relevance,
      confidence,
      reason,
      excerpts,
    };
  });
}

/**
 * Unpacks what the relations engine recorded about WHY a pair is related, for the gate.
 *
 * All of this already existed in `relations.evidence_json` and was simply never read — the
 * user was asked to confirm a document knowing only its name and a relation type.
 */
function relationEvidence(raw: string | null): {
  relevance: Relevance | '';
  confidence: { level: string; basis: string };
  reason: string;
  excerpts: Array<{ documentId: string; page: number; text: string }>;
} {
  // A document the user picked in the wizard has no relation row behind it, so there was
  // nothing to read and the band came back null — and a null band renders as nothing at
  // all, which is why a confirmed document looked like it had no confidence. It has the
  // highest one there is: a person decided, which is what every proposal approximates.
  const empty = {
    relevance: '' as const,
    confidence: manualConfidence(),
    reason: '',
    excerpts: [],
  };
  if (!raw) return empty;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return empty;
  }
  const ai = (parsed.ai || {}) as { rationale?: string; citation?: { documentId?: string; page?: number; excerpt?: string } };
  const deterministic = (parsed.deterministic || {}) as {
    referenceHits?: Array<{ text: string; page: number }>;
    titleMentions?: Array<{ inDocumentId: string; page: number; excerpt: string }>;
  };
  const excerpts: Array<{ documentId: string; page: number; text: string }> = [];
  if (ai.citation?.excerpt && ai.citation.page) {
    excerpts.push({ documentId: String(ai.citation.documentId || ''), page: Number(ai.citation.page), text: ai.citation.excerpt });
  }
  for (const mention of deterministic.titleMentions || []) {
    excerpts.push({ documentId: mention.inDocumentId, page: mention.page, text: mention.excerpt });
  }
  for (const hit of deterministic.referenceHits || []) {
    excerpts.push({ documentId: '', page: hit.page, text: hit.text });
  }
  const relevanceRaw = String(parsed.relevance || '');
  return {
    relevance: isRelevance(relevanceRaw) ? relevanceRaw : '',
    // Derived from the same evidence by the same function the Relações tab uses — an edge
    // must not read as one thing on the document and another in the gate.
    confidence: storedConfidence(parsed),
    reason: String(ai.rationale || parsed.heuristic || ''),
    // Three excerpts is what a decision needs; the rest is on the document's own page.
    excerpts: excerpts.slice(0, 3),
  };
}

/**
 * Revision step 1: identify candidate related documents. Runs the relations engine for
 * the main document, then folds every non-rejected relation into the analysis's document
 * set as PENDING — each awaiting the user's confirm/exclude (briefing §5.3).
 */
export async function identifyRelations(analysisId: string): Promise<AnalysisRow> {
  const analysis = requireAnalysis(analysisId);
  if (analysis.type !== 'revision') throw new ApiError('Only revision analyses identify related documents.', 400);
  if (analysis.state !== 'rascunho' && analysis.state !== 'a_identificar_relacoes') {
    throw new ApiError(`Cannot identify relations in state "${analysis.state}".`, 409);
  }

  setAnalysisState(analysisId, 'a_identificar_relacoes');
  try {
    const run = await proposeRelations(analysis.mainDocumentId);
    const db = getDb();
    const relations = listRelations(analysis.mainDocumentId).filter((rel) => rel.status !== 'rejected');
    for (const rel of relations) {
      db.prepare(
        `INSERT INTO analysis_documents (analysis_id, document_id, role, status, relation_type, relation_id)
         VALUES (?, ?, 'related', ?, ?, ?)
         ON CONFLICT(analysis_id, document_id) DO UPDATE SET relation_id = excluded.relation_id,
                                                             relation_type = excluded.relation_type
          WHERE analysis_documents.status = 'pending'`,
      ).run(
        analysisId,
        rel.toDocumentId,
        rel.status === 'confirmed' ? 'confirmed' : 'pending',
        rel.type,
        rel.relationId,
      );
    }
    recordEvent(analysisId, 'relations_identified', { ...run, candidates: relations.length });
    setAnalysisState(analysisId, 'a_aguardar_confirmacao_de_documentos');
    return requireAnalysis(analysisId);
  } catch (error) {
    throw failOperation(analysisId, 'identify_relations', 'Configuração', error);
  }
}

export function decideAnalysisDocument(
  analysisId: string,
  documentId: string,
  status: 'confirmed' | 'excluded',
): AnalysisDocumentRow[] {
  const analysis = requireAnalysis(analysisId);
  if (analysis.state !== 'a_aguardar_confirmacao_de_documentos') {
    throw new ApiError(`Documents are decided in state "a_aguardar_confirmacao_de_documentos", not "${analysis.state}".`, 409);
  }
  const db = getDb();
  const res = db
    .prepare(
      `UPDATE analysis_documents SET status = ?, decided_at = ? WHERE analysis_id = ? AND document_id = ? AND role = 'related'`,
    )
    .run(status, Date.now(), analysisId, documentId);
  if (Number(res.changes) === 0) throw new ApiError('Related document not found on this analysis.', 404);
  recordEvent(analysisId, status === 'confirmed' ? 'document_confirmed' : 'document_excluded', { documentId });
  return listAnalysisDocuments(analysisId);
}

// --- The run ---------------------------------------------------------------

/**
 * The pages of a document that fit into one stage's input budget.
 *
 * Taking pages in order until the budget runs out means that on a long document the
 * extraction simply never sees the later pages — and an obligation on page 90 of a 120-page
 * collective agreement is exactly the kind of thing this app exists to find. When the
 * document is indexed, pages are chosen by how close they are to the analysis's subject and
 * only then put back in reading order, so the model still sees ascending page numbers and
 * the citations it makes stay page-anchored.
 *
 * Order is the fallback, not the enemy: with no vectors, or with a document that fits
 * whole, this behaves exactly as it always did.
 */
function pagesBudgeted(documentId: string, subjectVec?: Float32Array | null): string {
  const pages = listPages(documentId).filter((page) => Boolean(page.text));
  const total = pages.reduce((sum, page) => sum + page.text.length, 0);

  let chosen = pages;
  if (subjectVec && total > RUN_PAGE_CHAR_BUDGET) {
    // A page's relevance is its BEST segment, not its average: one decisive clause on an
    // otherwise administrative page is the reason to include that page.
    const best = new Map<number, number>();
    for (const seg of segmentVectors([documentId])) {
      const score = cosine(subjectVec, seg.vec);
      if (score > (best.get(seg.page) ?? -1)) best.set(seg.page, score);
    }
    if (best.size > 0) {
      const ranked = [...pages].sort((a, b) => (best.get(b.page) ?? -1) - (best.get(a.page) ?? -1));
      const keep = new Set<number>();
      let room = RUN_PAGE_CHAR_BUDGET;
      for (const page of ranked) {
        if (page.text.length > room) continue;
        keep.add(page.page);
        room -= page.text.length;
      }
      chosen = pages.filter((page) => keep.has(page.page));
    }
  }

  let budget = RUN_PAGE_CHAR_BUDGET;
  const parts: string[] = [];
  for (const page of chosen) {
    if (budget <= 0) break;
    const chunk = page.text.slice(0, budget);
    parts.push(`--- page ${page.page} ---\n${chunk}`);
    budget -= chunk.length;
  }
  return parts.join('\n\n');
}

/**
 * What this analysis is ABOUT, encoded once per run and reused for every document it reads.
 * The main document's own subject plus whatever the user asked for in guidance.
 */
async function analysisSubjectVector(main: DocumentDetail, guidance: string): Promise<Float32Array | null> {
  const subject = [main.title || main.name, main.subject, main.topics.join(', '), guidance]
    .filter(Boolean)
    .join('. ');
  if (!subject) return null;
  return embedSubject(subject);
}

export function confirmedDocumentIds(analysisId: string): string[] {
  return listAnalysisDocuments(analysisId)
    .filter((doc) => doc.status === 'confirmed')
    .map((doc) => doc.documentId);
}

/**
 * Store a run's output as a NEW extraction on the active path. The previous one is left
 * alone: it is the artifact a user may already have reviewed, and replacing it silently —
 * which is what `DELETE FROM analysis_items` did — destroyed their decisions with no
 * record that anything had been lost.
 */
function validateAndStore(
  analysisId: string,
  kind: 'statement' | 'matrix_line',
  rawItems: SourcedItem[],
  fields: ExtractionField[],
): { accepted: number; rejected: number } {
  const letter = activePath(analysisId);
  const previous = listExtractions(analysisId).filter((e) => e.pathLetter === letter).pop();
  if (previous) {
    recordEvent(analysisId, 'items_discarded', {
      count: previous.acceptedCount,
      supersedes: previous.extractionId,
    });
  }
  const extraction = storeExtraction({
    analysisId,
    pathLetter: letter,
    kind,
    items: rawItems,
    fields,
    confirmedDocumentIds: new Set(confirmedDocumentIds(analysisId)),
    onRejected: (seq, reason) => recordEvent(analysisId, 'item_rejected', { seq, reason }),
  });
  return { accepted: extraction.acceptedCount, rejected: extraction.rejectedCount };
}

export async function runAnalysis(analysisId: string): Promise<AnalysisRow> {
  assertNotClosed(analysisId);
  const analysis = requireAnalysis(analysisId);
  const docs = listAnalysisDocuments(analysisId);
  const hasConfirmedRelated = docs.some((doc) => doc.role === 'related' && doc.status === 'confirmed');
  // A revision whose related set was picked in the wizard (already confirmed) may run
  // straight from rascunho — the identification step exists for when nobody picked.
  const runnableFrom: AnalysisState[] =
    analysis.type === 'summary'
      ? ['rascunho', 'erro']
      : hasConfirmedRelated
        ? ['rascunho', 'a_aguardar_confirmacao_de_documentos', 'erro']
        : ['a_aguardar_confirmacao_de_documentos', 'erro'];
  if (!runnableFrom.includes(analysis.state)) {
    throw new ApiError(`Cannot run from state "${analysis.state}".`, 409);
  }
  if (analysis.type === 'revision') {
    const pending = docs.filter((doc) => doc.role === 'related' && doc.status === 'pending');
    if (pending.length > 0) {
      throw new ApiError(`Confirm or exclude every related document first (${pending.length} pending).`, 409);
    }
    if (!hasConfirmedRelated) {
      throw new ApiError('A revision needs at least one confirmed related document.', 409);
    }
  }
  if (!(await aiConfigured())) {
    throw new ApiError('AI is not configured — connect ChatGPT in Settings to run analyses.', 400);
  }

  const main = getDocumentDetail(analysis.mainDocumentId);
  if (!main) throw new ApiError('Main document is gone.', 500);

  setAnalysisState(analysisId, 'em_processamento', 'A preparar os documentos…');
  recordEvent(analysisId, 'run_started', { type: analysis.type });
  const guidance = effectiveGuidance(analysisId, guidanceLineage(analysisId));
  const userGuidance = guidance
    ? `\nAdditional guidance from the user (follow it within the grounding rules):\n${guidance}`
    : '';
  try {
    const subjectVec = await analysisSubjectVector(main, guidance);
    // The fields the client asked for, as they stand now. They shape the schema AND are
    // spelled out in the instructions: a field the model is handed but never told the
    // purpose of comes back empty, which reads as "the app ignored my change".
    const fields = extractionFields(analysis.type);
    const fieldBrief = [
      'Fields to fill on every item, and what each one means:',
      ...fields.map((field) => `- ${field.key} (${field.label}): ${field.description}`),
      'Fill a field only from the document. Anything you cannot support belongs in evidence_quality "not_confirmed", never in a field presented as fact.',
    ].join('\n');
    let counts: { accepted: number; rejected: number };
    if (analysis.type === 'summary') {
      setAnalysisState(analysisId, 'em_processamento', 'A extrair as afirmações do documento principal…');
      const result = await aiStructured<{ statements: SourcedItem[] }>({
        task: 'extract_summary',
        instructions: [
          `Produce the structured summary of the MAIN document (id "${main.documentId}", "${main.title || main.name}", version "${main.versionLabel || ''}").`,
          'Extract every obligation, deadline, responsibility, sanction, reference and relevant definition as individual statements.',
          `Every statement citing the document uses source_document_id "${main.documentId}" with the real page and a verbatim excerpt from that page.`,
          `A statement you cannot support gets evidence_quality "not_confirmed", empty source fields, and its content must be exactly: "${NOT_CONFIRMED_SENTENCE}". Your own suggestions set ai_suggestion=true.`,
          fieldBrief + userGuidance,
        ].join('\n'),
        input: [
          { type: 'input_text', text: pagesBudgeted(main.documentId, subjectVec) },
          ...docs
            .filter((doc) => doc.role === 'related' && doc.status === 'confirmed')
            .map((doc) => ({
              type: 'input_text' as const,
              text: `=== SUPPORTING document id "${doc.documentId}" (may be cited) ===\n${pagesBudgeted(doc.documentId, subjectVec)}`,
            })),
        ],
        schema: summaryExtractionSchema(fields),
        reasoningEffort: 'medium',
      });
      counts = validateAndStore(analysisId, 'statement', result.statements, fields);
    } else {
      setAnalysisState(analysisId, 'em_processamento', 'A construir a matriz comparativa com os documentos confirmados…');
      const related = listAnalysisDocuments(analysisId).filter(
        (doc) => doc.role === 'related' && doc.status === 'confirmed',
      );
      const relatedBlocks = related
        .map((doc) => {
          const detail = getDocumentDetail(doc.documentId);
          return `=== RELATED document id "${doc.documentId}" (“${detail?.title || doc.documentName}”, relation: ${doc.relationType || '—'}) ===\n${pagesBudgeted(doc.documentId, subjectVec)}`;
        })
        .join('\n\n');
      const result = await aiStructured<{ lines: SourcedItem[] }>({
        task: 'build_comparative_matrix',
        instructions: [
          `Build the comparative matrix for revising the MAIN document (id "${main.documentId}", "${main.title || main.name}") against each CONFIRMED related document.`,
          'One line per point of comparison: what the main document currently states (with its page), what the related document states, the relationship type, the difference, the proposed change, its impact, and whether it requires a legal decision by the user.',
          'source_document_id/source_page/source_excerpt cite the RELATED document supporting the line (real page, verbatim excerpt). current_page cites the MAIN document (0 when it is silent on the topic).',
          'requires_legal_decision=true whenever applying the change involves legal judgement rather than mechanical alignment. Never propose removing an obligation without flagging it.',
          fieldBrief + userGuidance,
        ].join('\n'),
        input: [
          { type: 'input_text', text: `=== MAIN document id "${main.documentId}" ===\n${pagesBudgeted(main.documentId, subjectVec)}` },
          { type: 'input_text', text: relatedBlocks },
        ],
        schema: revisionMatrixSchema(fields),
        reasoningEffort: 'high',
      });
      setAnalysisState(analysisId, 'em_processamento', 'A validar as citações de cada linha…');
      counts = validateAndStore(analysisId, 'matrix_line', result.lines, fields);
    }
    recordEvent(analysisId, 'run_completed', counts);
    setAnalysisState(
      analysisId,
      'pronta_para_revisao',
      counts.rejected > 0 ? `${counts.rejected} item(ns) rejeitado(s) pelos validadores de citações.` : '',
    );
    return requireAnalysis(analysisId);
  } catch (error) {
    throw failOperation(analysisId, 'run', analysis.type === 'revision' ? 'Matriz comparativa' : 'Extração', error);
  }
}

// --- Review + approval -----------------------------------------------------

export function decideItem(analysisId: string, itemId: string, decision: 'accepted' | 'rejected'): void {
  const analysis = requireAnalysis(analysisId);
  if (analysis.state !== 'pronta_para_revisao') {
    throw new ApiError(`Items are decided in state "pronta_para_revisao", not "${analysis.state}".`, 409);
  }
  const res = getDb()
    .prepare('UPDATE analysis_items SET decision = ?, decided_at = ? WHERE item_id = ? AND analysis_id = ? AND accepted = 1')
    .run(decision, Date.now(), itemId, analysisId);
  if (Number(res.changes) === 0) throw new ApiError('Item not found (or was validator-rejected).', 404);
  recordEvent(analysisId, 'item_decided', { itemId, decision });
}

/**
 * Approve the extraction — the gate of the Revisão phase. What is approved is the WHOLE
 * structured output, not one statement at a time: the approval is recorded on the
 * extraction artifact, so it survives a later re-run producing a different one.
 *
 * The single exception to whole-output approval is a matrix line flagged
 * requires_legal_decision, which the briefing insists is decided explicitly, one by one.
 */
export function approveAnalysis(analysisId: string, approvedBy = ''): AnalysisRow {
  assertNotClosed(analysisId);
  const analysis = requireAnalysis(analysisId);
  if (analysis.state !== 'pronta_para_revisao') {
    throw new ApiError(`Only an analysis "pronta_para_revisao" can be approved, not "${analysis.state}".`, 409);
  }
  const extraction = listExtractions(analysisId)
    .filter((e) => e.pathLetter === activePath(analysisId))
    .pop();
  if (!extraction) throw new ApiError('Ainda não existe uma extração para rever.', 409);

  const undecided = pendingLegalDecisions(extraction.extractionId);
  if (undecided.length > 0) {
    throw new ApiError(`${undecided.length} linha(s) exigem uma decisão jurídica antes de continuar.`, 409);
  }
  markExtractionApproved(extraction.extractionId, approvedBy);
  setAnalysisState(analysisId, 'aprovada');
  recordEvent(analysisId, 'extraction_approved', { extractionId: extraction.extractionId, label: extraction.label });
  return requireAnalysis(analysisId);
}

export function rejectAnalysisExtraction(
  analysisId: string,
  rejectedBy: string,
  reason: string,
): { newPath: string; state: AnalysisState } {
  assertNotClosed(analysisId);
  const analysis = requireAnalysis(analysisId);
  if (analysis.state !== 'pronta_para_revisao') {
    throw new ApiError('Só pode rejeitar o conjunto quando os resultados estão prontos para revisão.', 409);
  }
  const trimmed = reason.trim();
  if (!trimmed) throw new ApiError('Explique o que deve ser corrigido na nova tentativa.', 400);
  const extraction = listExtractions(analysisId)
    .filter((entry) => entry.pathLetter === activePath(analysisId))
    .pop();
  if (!extraction) throw new ApiError('Ainda não existem resultados para rejeitar.', 409);

  const db = getDb();
  db.exec('BEGIN');
  try {
    markExtractionRejected(extraction.extractionId, rejectedBy, trimmed);
    recordEvent(analysisId, 'extraction_rejected', {
      extractionId: extraction.extractionId,
      label: extraction.label,
      reason: trimmed.slice(0, 300),
    });
    const result = applyTrackBack(analysisId, 'extracao', trimmed, 'run');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function deleteAnalysis(analysisId: string): void {
  requireAnalysis(analysisId);
  setAnalysisState(analysisId, 'eliminada');
  recordEvent(analysisId, 'deleted', {});
}

// --- Items + events reads --------------------------------------------------

export type AnalysisItemRow = {
  itemId: string;
  seq: number;
  kind: 'statement' | 'matrix_line';
  payload: SourcedItem & Record<string, unknown>;
  accepted: boolean;
  rejectionReason: string;
  decision: 'pending' | 'accepted' | 'rejected';
};

/**
 * The items of the extraction in force. Without an explicit extraction, the newest one on
 * the analysis's active path — so a re-run's output replaces the previous one for every
 * reader without either being deleted.
 */
export function listItems(analysisId: string, extractionId?: string): AnalysisItemRow[] {
  const target =
    extractionId ||
    listExtractions(analysisId)
      .filter((e) => e.pathLetter === activePath(analysisId))
      .pop()?.extractionId ||
    listExtractions(analysisId).pop()?.extractionId ||
    '';
  if (!target) return [];
  const rows = getDb()
    .prepare('SELECT * FROM analysis_items WHERE extraction_id = ? ORDER BY seq')
    .all(target) as Array<{
    item_id: string;
    seq: number;
    kind: 'statement' | 'matrix_line';
    payload_json: string;
    accepted: number;
    rejection_reason: string;
    decision: 'pending' | 'accepted' | 'rejected';
  }>;
  return rows.map((row) => ({
    itemId: row.item_id,
    seq: row.seq,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as AnalysisItemRow['payload'],
    accepted: Boolean(row.accepted),
    rejectionReason: row.rejection_reason,
    decision: row.decision,
  }));
}

export function listEvents(
  analysisId: string,
): Array<{ kind: string; detail: Record<string, unknown>; pathLetter: string; createdAt: number }> {
  const rows = getDb()
    .prepare('SELECT kind, detail_json, path_letter, created_at FROM analysis_events WHERE analysis_id = ? ORDER BY created_at')
    .all(analysisId) as Array<{ kind: string; detail_json: string; path_letter: string; created_at: number }>;
  return rows.map((row) => ({
    kind: row.kind,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
    pathLetter: row.path_letter || 'a',
    createdAt: row.created_at,
  }));
}

/**
 * Close the analysis: the e-mail was approved, so the work is done. Nothing is deleted and
 * nothing is frozen except the ability to act — reverting to an earlier phase reopens it,
 * which is the only way back in and is deliberately always available.
 */
export function closeAnalysis(analysisId: string, approvedBy = ''): AnalysisRow {
  const analysis = requireAnalysis(analysisId);
  if (analysis.closedAt) return analysis;
  getDb()
    .prepare('UPDATE analyses SET closed_at = ?, state = ?, updated_at = ? WHERE analysis_id = ?')
    .run(Date.now(), 'aprovada', Date.now(), analysisId);
  // The approval is recorded by the act that made it (buildEmlDraft). This records the
  // CONSEQUENCE — which is also the only thing that ever said an analysis had ended.
  recordEvent(analysisId, 'analysis_closed', { approvedBy });
  return requireAnalysis(analysisId);
}

/** Reverting reopens a closed analysis — the work continues on the new path. */
export function reopenAnalysis(analysisId: string): void {
  getDb().prepare('UPDATE analyses SET closed_at = NULL WHERE analysis_id = ?').run(analysisId);
  recordEvent(analysisId, 'analysis_reopened', {});
}

/** The user has seen the §15 warning and decided about it. */
export function dismissAffected(analysisId: string): void {
  getDb()
    .prepare("UPDATE analyses SET potentially_affected = 0, affected_reason = '', updated_at = ? WHERE analysis_id = ?")
    .run(Date.now(), analysisId);
  recordEvent(analysisId, 'affected_dismissed', {});
}

// --- Track-back (fork a stage and redo it with new guidance) ---------------

/**
 * Track back to a stage: branch a new path from the current tip, append the user's answer
 * to the analysis guidance (kept per path in the event trail), reset the state to what
 * that stage needs, and let the caller re-trigger the work. Deterministic prompts live in
 * stages.ts; this function only executes the consequence.
 */
export function applyTrackBack(
  analysisId: string,
  stageKey: string,
  guidance: string,
  restart: 'run' | 'relations' | 'generate' | 'review_only',
): { newPath: string; state: AnalysisState } {
  const analysis = requireAnalysis(analysisId);
  const db = getDb();

  // Fork from the newest version if there is one; otherwise stay on the current path
  // (nothing generated yet means there is nothing to branch away from).
  const tip = db
    .prepare('SELECT version_id FROM analysis_versions WHERE analysis_id = ? ORDER BY version_no DESC LIMIT 1')
    .get(analysisId) as { version_id: string } | undefined;
  let newPath = db.prepare('SELECT active_path FROM analyses WHERE analysis_id = ?').get(analysisId) as
    | { active_path: string }
    | undefined;
  let letter = newPath?.active_path || 'a';
  if (tip) {
    const maxLetter = (db
      .prepare("SELECT COALESCE(MAX(letter), 'a') AS m FROM analysis_paths WHERE analysis_id = ?")
      .get(analysisId) as { m: string }).m;
    letter = String.fromCharCode(maxLetter.charCodeAt(0) + 1);
    if (letter > 'z') throw new ApiError('Path letters exhausted (26 forks).', 409);
    db.prepare(
      'INSERT INTO analysis_paths (analysis_id, letter, parent_version_id, parent_stage, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(analysisId, letter, tip.version_id, stageKey, Date.now());
    db.prepare('UPDATE analyses SET active_path = ? WHERE analysis_id = ?').run(letter, analysisId);
  }

  // A closed analysis reopens by being reverted — that is the whole readmission rule.
  if (analysis.closedAt) reopenAnalysis(analysisId);

  // The answer belongs to the path this revert produced. A sibling path re-run later must
  // not inherit an instruction that was given while reworking a different one.
  const existing = (db.prepare('SELECT guidance FROM analysis_paths WHERE analysis_id = ? AND letter = ?').get(
    analysisId,
    letter,
  ) as { guidance?: string } | undefined)?.guidance;
  const merged = [existing || '', `[${stageKey}] ${guidance.trim()}`].filter(Boolean).join('\n');
  db.prepare('UPDATE analysis_paths SET guidance = ? WHERE analysis_id = ? AND letter = ?').run(
    merged.slice(0, 8000),
    analysisId,
    letter,
  );
  db.prepare('UPDATE analyses SET updated_at = ? WHERE analysis_id = ?').run(Date.now(), analysisId);

  // The state the restart needs. 'review_only' keeps the items and reopens review.
  const nextState: AnalysisState =
    restart === 'relations'
      ? 'rascunho'
      : restart === 'run'
        ? analysis.type === 'revision'
          ? 'a_aguardar_confirmacao_de_documentos'
          : 'rascunho'
        : 'pronta_para_revisao';
  setAnalysisState(analysisId, nextState, '');
  if (restart === 'review_only') {
    // Reopen every decision so the user re-judges with the new criterion.
    db.prepare(
      `UPDATE analysis_items SET decision = 'pending', decided_at = NULL WHERE analysis_id = ? AND accepted = 1`,
    ).run(analysisId);
  }
  recordEvent(analysisId, 'tracked_back', { stage: stageKey, newPath: letter, guidance: guidance.slice(0, 300), restart });
  return { newPath: letter, state: nextState };
}

// --- "Potencialmente afetada" (§15) ---------------------------------------

/**
 * Called by the ingest pipeline when a document's CONTENT changed (new hash) or a new
 * document was classified. Flags — never regenerates — every non-deleted analysis whose
 * confirmed set contains the changed document, or whose main document the new document
 * references by name.
 */
export function flagPotentiallyAffected(documentId: string, reason: 'content_changed' | 'new_document'): number {
  const db = getDb();
  const doc = getDocumentDetail(documentId);
  if (!doc) return 0;
  // Never flag an analysis because of a document THIS APP generated (§15 is about the
  // client's source material changing, not about our own outputs syncing back).
  if (!isReadableDocument(doc.path)) return 0;
  let flagged = 0;

  const analyses = db
    .prepare(`SELECT analysis_id, main_document_id FROM analyses WHERE state IN ('aprovada','pronta_para_revisao')`)
    .all() as Array<{ analysis_id: string; main_document_id: string }>;

  for (const analysis of analyses) {
    let hit = '';
    if (reason === 'content_changed') {
      const inSet = db
        .prepare(
          `SELECT 1 FROM analysis_documents WHERE analysis_id = ? AND document_id = ? AND status = 'confirmed'`,
        )
        .get(analysis.analysis_id, documentId);
      if (inSet) hit = `O documento "${doc.name}" foi alterado no OneDrive depois desta análise.`;
    } else {
      const main = getDocumentDetail(analysis.main_document_id);
      if (main) {
        const names = [main.title, main.name].map((n) => n.toLowerCase()).filter((n) => n.length >= 5);
        const referencesMain = doc.references.some((ref) => names.some((n) => ref.text.toLowerCase().includes(n)));
        if (referencesMain) hit = `O novo documento "${doc.name}" referencia "${main.title || main.name}".`;
      }
    }
    if (hit) {
      db.prepare(
        'UPDATE analyses SET potentially_affected = 1, affected_reason = ?, updated_at = ? WHERE analysis_id = ?',
      ).run(hit, Date.now(), analysis.analysis_id);
      recordEvent(analysis.analysis_id, 'potentially_affected', { documentId, reason: hit });
      flagged += 1;
    }
  }
  return flagged;
}
