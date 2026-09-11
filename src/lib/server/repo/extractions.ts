import { ApiError } from '@/app/api/_helpers';
import { validateAnalysisItem, type SourcedItem } from '@/lib/server/analysis-rules';
import { genId } from '@/lib/server/crypto';
import { getDb } from '@/lib/server/db';
import { type ExtractionField } from '@/lib/server/repo/extraction-template';
import { excerptOnPage } from '@/lib/server/ingest/pages';
import { getDocumentDetail } from '@/lib/server/repo/library';

// The extraction: the structured output of one run (briefing §10), as an immutable
// artifact. It is what the user approves — as a WHOLE, not statement by statement — before
// any document is written.
//
// The chain works exactly like analysis_versions, and for the same reason: a re-run or a
// manual edit appends a new extraction, so the one a decision was taken on still exists.
// Before this, a re-run did `DELETE FROM analysis_items` and every decision taken on the
// previous output disappeared with no record that it ever happened.

export type ExtractionRow = {
  extractionId: string;
  analysisId: string;
  pathLetter: string;
  seq: number;
  /** v1a, v2a… — the same identity scheme the document versions use. */
  label: string;
  origin: 'agent' | 'manual';
  acceptedCount: number;
  rejectedCount: number;
  approvedAt: number | null;
  approvedBy: string;
  rejectedAt: number | null;
  rejectedBy: string;
  rejectionReason: string;
  note: string;
  createdAt: number;
  /** The content fields this extraction was produced with. Empty for rows predating them. */
  fields: ExtractionField[];
};

type DbExtractionRow = {
  extraction_id: string;
  analysis_id: string;
  path_letter: string;
  seq: number;
  origin: 'agent' | 'manual';
  accepted_count: number;
  rejected_count: number;
  approved_at: number | null;
  approved_by: string;
  rejected_at: number | null;
  rejected_by: string;
  rejection_reason: string;
  note: string;
  created_at: number;
  fields_json: string;
};

function toRow(row: DbExtractionRow): ExtractionRow {
  return {
    extractionId: row.extraction_id,
    analysisId: row.analysis_id,
    pathLetter: row.path_letter,
    seq: row.seq,
    label: `e${row.seq}${row.path_letter}`,
    origin: row.origin,
    acceptedCount: row.accepted_count,
    rejectedCount: row.rejected_count,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    rejectedAt: row.rejected_at,
    rejectedBy: row.rejected_by,
    rejectionReason: row.rejection_reason,
    note: row.note,
    createdAt: row.created_at,
    fields: parseFields(row.fields_json),
  };
}

function parseFields(value: string): ExtractionField[] {
  if (!value) return [];
  try {
    return JSON.parse(value) as ExtractionField[];
  } catch {
    return [];
  }
}

export function listExtractions(analysisId: string): ExtractionRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM analysis_extractions WHERE analysis_id = ? ORDER BY created_at')
    .all(analysisId) as DbExtractionRow[];
  return rows.map(toRow);
}

export function getExtraction(analysisId: string, extractionId: string): ExtractionRow {
  const row = getDb()
    .prepare('SELECT * FROM analysis_extractions WHERE analysis_id = ? AND extraction_id = ?')
    .get(analysisId, extractionId) as DbExtractionRow | undefined;
  if (!row) throw new ApiError('Extraction not found.', 404);
  return toRow(row);
}

/**
 * The extraction in force for a path: the newest one produced on it, or — when the path
 * has not run its own yet — the newest one it inherited from the ancestors it branched
 * from. A path that forked after the extraction reviews the same output, as it should.
 */
export function currentExtraction(analysisId: string, lineage: string[]): ExtractionRow | null {
  const all = listExtractions(analysisId);
  for (const letter of lineage) {
    const own = all.filter((e) => e.pathLetter === letter);
    if (own.length) return own[own.length - 1];
  }
  return null;
}

export type ExtractionItem = {
  itemId: string;
  seq: number;
  kind: 'statement' | 'matrix_line';
  payload: Record<string, unknown>;
  accepted: boolean;
  rejectionReason: string;
  decision: 'pending' | 'accepted' | 'rejected';
};

export function extractionItems(extractionId: string): ExtractionItem[] {
  const rows = getDb()
    .prepare('SELECT * FROM analysis_items WHERE extraction_id = ? ORDER BY seq')
    .all(extractionId) as Array<{
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
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    accepted: row.accepted === 1,
    rejectionReason: row.rejection_reason,
    decision: row.decision,
  }));
}

function nextSeq(analysisId: string, pathLetter: string): number {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM analysis_extractions WHERE analysis_id = ? AND path_letter = ?')
    .get(analysisId, pathLetter) as { n: number };
  return row.n + 1;
}

/**
 * Validate a set of raw items and store them as a NEW extraction. Every item is kept —
 * accepted or rejected — because the rejections and their reasons are part of what the
 * user reviews; only accepted items ever reach a document.
 */
export function storeExtraction(options: {
  analysisId: string;
  pathLetter: string;
  kind: 'statement' | 'matrix_line';
  items: SourcedItem[];
  /**
   * The content fields in force when this extraction was produced, stored WITH it. The
   * template can change afterwards; an extraction already approved must keep being read
   * with the fields it actually had, exactly as a version keeps its template version.
   */
  fields?: ExtractionField[];
  origin?: 'agent' | 'manual';
  note?: string;
  confirmedDocumentIds: Set<string>;
  onRejected?: (seq: number, reason: string) => void;
}): ExtractionRow {
  const db = getDb();
  const extractionId = genId('ext');
  const now = Date.now();
  const seq = nextSeq(options.analysisId, options.pathLetter);
  let accepted = 0;
  let rejected = 0;

  const insert = db.prepare(
    `INSERT INTO analysis_items
       (item_id, analysis_id, extraction_id, seq, kind, payload_json, accepted, rejection_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO analysis_extractions
         (extraction_id, analysis_id, path_letter, seq, origin, accepted_count, rejected_count, note, created_at, fields_json)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
    ).run(
      extractionId,
      options.analysisId,
      options.pathLetter,
      seq,
      options.origin || 'agent',
      options.note || '',
      now,
      options.fields ? JSON.stringify(options.fields) : '',
    );

    options.items.forEach((item, index) => {
      // §11 runs on every stored item — including a manual edit, so an edit cannot
      // introduce a citation the app has not verified.
      const sourceDoc = item.source_document_id ? getDocumentDetail(item.source_document_id) : null;
      const verdict = validateAnalysisItem(item, {
        sourceExists: Boolean(sourceDoc),
        sourceConfirmed: options.confirmedDocumentIds.has(item.source_document_id),
        pageExists: sourceDoc ? item.source_page >= 1 && item.source_page <= sourceDoc.pageCount : false,
        excerptOnPage: sourceDoc
          ? excerptOnPage(item.source_document_id, item.source_page, item.source_excerpt)
          : false,
      });
      if (verdict.accepted) accepted += 1;
      else {
        rejected += 1;
        options.onRejected?.(index, verdict.reason);
      }
      insert.run(
        genId('itm'),
        options.analysisId,
        extractionId,
        index,
        options.kind,
        JSON.stringify(item),
        verdict.accepted ? 1 : 0,
        verdict.accepted ? '' : verdict.reason,
        now,
      );
    });

    db.prepare('UPDATE analysis_extractions SET accepted_count = ?, rejected_count = ? WHERE extraction_id = ?').run(
      accepted,
      rejected,
      extractionId,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return getExtraction(options.analysisId, extractionId);
}

/** Approve the whole output. The gate of the Revisão phase; recorded on the artifact. */
export function markExtractionApproved(extractionId: string, approvedBy: string): void {
  getDb()
    .prepare('UPDATE analysis_extractions SET approved_at = ?, approved_by = ? WHERE extraction_id = ?')
    .run(Date.now(), approvedBy, extractionId);
}

/** Reject the whole artifact without deleting it; a later run appends its replacement. */
export function markExtractionRejected(extractionId: string, rejectedBy: string, reason: string): void {
  getDb()
    .prepare(
      `UPDATE analysis_extractions
          SET rejected_at = ?, rejected_by = ?, rejection_reason = ?
        WHERE extraction_id = ? AND approved_at IS NULL AND rejected_at IS NULL`,
    )
    .run(Date.now(), rejectedBy, reason.slice(0, 4000), extractionId);
}

/** Matrix lines flagged requires_legal_decision that nobody has decided yet. */
export function pendingLegalDecisions(extractionId: string): ExtractionItem[] {
  return extractionItems(extractionId).filter(
    (item) =>
      item.accepted &&
      item.decision === 'pending' &&
      (item.payload as { requires_legal_decision?: boolean }).requires_legal_decision === true,
  );
}
