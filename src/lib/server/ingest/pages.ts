import { getDb } from '@/lib/server/db';
import { foldPt } from '@/lib/text-normalize';

// Reads over the page-anchored text store — the app's ground truth for citations.

export type PageRow = {
  page: number;
  text: string;
  ocr: boolean;
  pendingOcr: boolean;
};

export function listPages(documentId: string): PageRow[] {
  const rows = getDb()
    .prepare('SELECT page, text, ocr, pending_ocr FROM document_pages WHERE document_id = ? ORDER BY page')
    .all(documentId) as Array<{ page: number; text: string; ocr: number; pending_ocr: number }>;
  return rows.map((row) => ({
    page: row.page,
    text: row.text,
    ocr: Boolean(row.ocr),
    pendingOcr: Boolean(row.pending_ocr),
  }));
}

export function getPageText(documentId: string, page: number): string | null {
  const row = getDb()
    .prepare('SELECT text FROM document_pages WHERE document_id = ? AND page = ?')
    .get(documentId, page) as { text: string } | undefined;
  return row ? row.text : null;
}

// Whitespace-insensitive, case-insensitive containment — an excerpt survives line wrapping
// and spacing differences, but NOT paraphrase: the words must be there, in order.
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The citation ground-truth check (briefing §10): does this excerpt actually appear on
 * this page of this document? Phase 4's validators call this for every AI citation.
 */
export function excerptOnPage(documentId: string, page: number, excerpt: string): boolean {
  const text = getPageText(documentId, page);
  if (text === null) return false;
  const needle = normalizeForMatch(excerpt);
  if (!needle) return false;
  return normalizeForMatch(text).includes(needle);
}

/**
 * The same containment question, but folding accents and punctuation the way a reader does.
 *
 * Deliberately NOT the same function as excerptOnPage. That one is the citation ground
 * truth: an AI's excerpt must be on the page as written, and loosening it would weaken
 * every §10 validator. This one exists for the relation engine, which compares a document's
 * TITLE — already accent-folded, because that is how it was searched — against page text.
 * With the strict check, any title containing an accent could never verify, which quietly
 * disabled the title-mention signal for most of a Portuguese library.
 */
export function foldedMentionOnPage(documentId: string, page: number, text: string): boolean {
  const pageText = getPageText(documentId, page);
  if (pageText === null) return false;
  const needle = foldPt(text).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!needle) return false;
  const haystack = foldPt(pageText).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ');
  return haystack.includes(needle);
}

export type SegmentHit = {
  documentId: string;
  page: number;
  text: string;
};

/**
 * Full-text search over the segment index (FTS5). Query is treated as plain words.
 *
 * `documentId` narrows the search INSIDE SQL. It used to be applied by the caller to the
 * global top-N, which meant a title containing a common word ranked below unrelated
 * documents and a genuine mention inside the document being checked was invisible.
 */
export function searchSegments(query: string, options?: { limit?: number; documentId?: string }): SegmentHit[] {
  const words = String(query || '')
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  if (words.length === 0) return [];
  // Quote every token so user input can never inject FTS5 query syntax.
  const match = words.map((w) => `"${w}"`).join(' ');
  const limit = Math.min(Math.max(Number(options?.limit || 20), 1), 100);
  const db = getDb();
  const rows = (
    options?.documentId
      ? db
          .prepare(
            `SELECT s.document_id, s.page, s.text
             FROM segments_fts f JOIN segments s ON s.rowid = f.rowid
             WHERE segments_fts MATCH ? AND s.document_id = ? ORDER BY rank LIMIT ?`,
          )
          .all(match, options.documentId, limit)
      : db
          .prepare(
            `SELECT s.document_id, s.page, s.text
             FROM segments_fts f JOIN segments s ON s.rowid = f.rowid
             WHERE segments_fts MATCH ? ORDER BY rank LIMIT ?`,
          )
          .all(match, limit)
  ) as Array<{
    document_id: string;
    page: number;
    text: string;
  }>;
  return rows.map((row) => ({ documentId: row.document_id, page: row.page, text: row.text }));
}
