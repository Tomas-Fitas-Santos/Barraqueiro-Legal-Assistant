import { getDb } from '@/lib/server/db';
import { cosine } from '@/lib/server/ingest/embed';
import { foldedMentionOnPage, searchSegments } from '@/lib/server/ingest/pages';
import { documentVectors } from '@/lib/server/ingest/semantic-index';
import { isReadableDocument } from '@/lib/library-layout';
import { foldPt as normalize } from '@/lib/text-normalize';
import { getDocumentDetail, listDocuments, type DocumentDetail } from '@/lib/server/repo/library';

// The deterministic half of relation discovery (briefing §9), separated from the judgement
// so it can run WHILE a document is processed (§7 step 10) instead of when an analysis asks.
//
// That is what makes a processed document ready: open it in the Library and its relations
// are already on the Relações tab. The cost of getting there is the whole design problem —
// done naively, a 500-file sync is 250 000 evidence gatherings — so the shape here is:
// one pass over the library per dirty document, not one pass per pair.

export type CandidateEvidence = {
  referenceHits: Array<{ direction: 'from_cites_to' | 'to_cites_from'; text: string; page: number }>;
  titleMentions: Array<{ inDocumentId: string; page: number; excerpt: string }>;
  topicOverlap: string[];
  entityMatch: boolean;
  sameFolder: boolean;
  /**
   * The sixth signal (§7.9). Cosine against the other document's vector, and this
   * candidate's RANK among all candidates by that cosine — 1 is the closest document in
   * the library.
   *
   * The rank is what the engine acts on, never the score. Measured on the client's own
   * documents the encoder puts an on-topic passage at ~0.90 and an unrelated one at ~0.81,
   * so a fixed cutoff would either admit everything or nothing depending on the corpus.
   */
  semantic: { score: number; rank: number } | null;
};

export type Candidate = { candidate: DocumentDetail; evidence: CandidateEvidence };

/**
 * How many of the library's closest documents get onto the shortlist on similarity alone.
 *
 * Small on purpose. The shortlist is what one AI call reads, and every semantic-only entry
 * spends part of that call on a candidate no exact evidence supports.
 */
const SEMANTIC_SHORTLIST = 5;

/** How many segment hits one title search may return before the app stops looking. */
const TITLE_SEARCH_LIMIT = 60;

/** Names/titles a document is known by, for reference matching. */
function knownNames(doc: DocumentDetail): string[] {
  return [doc.title, doc.name.replace(/\.[a-z0-9]+$/i, '')].map(normalize).filter((n) => n.length >= 5);
}

/** Signals the app found by matching TEXT — the only kind §9 lets a strong type rest on. */
export function hasExactSignal(evidence: CandidateEvidence): boolean {
  return evidence.referenceHits.length > 0 || evidence.titleMentions.length > 0;
}

export function hasSignal(evidence: CandidateEvidence): boolean {
  return (
    hasExactSignal(evidence) ||
    evidence.topicOverlap.length >= 2 ||
    (evidence.topicOverlap.length >= 1 && (evidence.entityMatch || evidence.sameFolder)) ||
    // The gain the semantic index exists for: two documents on the same subject that share
    // no common phrase were previously never even shown to the AI.
    (evidence.semantic !== null && evidence.semantic.rank <= SEMANTIC_SHORTLIST)
  );
}

/** True when similarity is the ONLY reason this candidate is here. */
export function isSemanticOnly(evidence: CandidateEvidence): boolean {
  return (
    !hasExactSignal(evidence) && evidence.topicOverlap.length === 0 && !evidence.entityMatch && evidence.semantic !== null
  );
}

/** The library a document can be related TO: indexed, not removed, not the app's own output. */
export function relatableDocuments(exceptDocumentId?: string): DocumentDetail[] {
  return listDocuments()
    .filter(
      (doc) =>
        doc.documentId !== exceptDocumentId &&
        doc.state === 'indexed' &&
        isReadableDocument(doc.path),
    )
    .map((doc) => getDocumentDetail(doc.documentId))
    .filter((doc): doc is DocumentDetail => Boolean(doc));
}

/**
 * All of one document's evidence against the whole library, in one pass.
 *
 * The per-pair version ran a full-text search per candidate, which is what made this
 * quadratic: 500 documents meant 500 FTS queries for one document's title. Here each of the
 * main document's names is searched ONCE and the hits are grouped by the document they
 * landed in, so the cost is the size of the library, not its square.
 */
export function gatherCandidates(main: DocumentDetail, library: DocumentDetail[]): Candidate[] {
  const mainNames = knownNames(main);
  const mainTopics = new Set(main.topics.map(normalize));
  const mainEntity = normalize(main.entity);

  // One search per name, verified against the page store, grouped by document.
  const mentionsByDocument = new Map<string, CandidateEvidence['titleMentions']>();
  for (const name of mainNames) {
    for (const hit of searchSegments(name, { limit: TITLE_SEARCH_LIMIT })) {
      if (hit.documentId === main.documentId) continue;
      if (!foldedMentionOnPage(hit.documentId, hit.page, name)) continue;
      const list = mentionsByDocument.get(hit.documentId) || [];
      list.push({ inDocumentId: hit.documentId, page: hit.page, excerpt: name });
      mentionsByDocument.set(hit.documentId, list);
    }
  }

  const mainReferences = main.references.map((ref) => ({ ref, text: normalize(ref.text) }));

  const pairs: Candidate[] = library.map((candidate) => {
    const evidence: CandidateEvidence = {
      referenceHits: [],
      titleMentions: mentionsByDocument.get(candidate.documentId) || [],
      topicOverlap: [],
      entityMatch: false,
      sameFolder: false,
      semantic: null,
    };
    const candidateNames = knownNames(candidate);
    for (const { ref, text } of mainReferences) {
      if (candidateNames.some((n) => text.includes(n) || n.includes(text))) {
        evidence.referenceHits.push({ direction: 'from_cites_to', text: ref.text, page: ref.citation.page });
      }
    }
    for (const ref of candidate.references) {
      const refText = normalize(ref.text);
      if (mainNames.some((n) => refText.includes(n) || n.includes(refText))) {
        evidence.referenceHits.push({ direction: 'to_cites_from', text: ref.text, page: ref.citation.page });
      }
    }
    evidence.topicOverlap = candidate.topics.filter((topic) => mainTopics.has(normalize(topic)));
    evidence.entityMatch = Boolean(mainEntity && mainEntity === normalize(candidate.entity));
    evidence.sameFolder = main.path === candidate.path;
    return { candidate, evidence };
  });

  attachSemantic(main.documentId, pairs);
  return pairs;
}

/**
 * Stamps each pair with its similarity rank, reading the whole library's vectors ONCE.
 *
 * Silently a no-op when the encoder is unavailable or the corpus has not been indexed — the
 * five exact-string signals then carry the shortlist exactly as they did before.
 */
function attachSemantic(mainDocumentId: string, pairs: Candidate[]): void {
  const vectors = new Map(documentVectors().map((entry) => [entry.documentId, entry.vec]));
  const mainVec = vectors.get(mainDocumentId);
  if (!mainVec) return;
  pairs
    .map((pair) => {
      const vec = vectors.get(pair.candidate.documentId);
      return vec ? { pair, score: cosine(mainVec, vec) } : null;
    })
    .filter((entry): entry is { pair: Candidate; score: number } => entry !== null)
    .sort((a, b) => b.score - a.score)
    .forEach((entry, index) => {
      entry.pair.evidence.semantic = { score: Number(entry.score.toFixed(4)), rank: index + 1 };
    });
}

// --- the cache -------------------------------------------------------------------------

/**
 * The content a comparison actually reads, as one string.
 *
 * Not just the file hash: `gatherCandidates` matches on the title, the entity, the topics
 * and the recorded references, all of which the classifier writes AFTER ingest and a user
 * can correct afterwards (§8). A fingerprint over the bytes alone would call a pair covered
 * while the very fields the comparison ran on had changed underneath it.
 */
export function fingerprintOf(doc: DocumentDetail): string {
  return [
    doc.sha256,
    doc.title,
    doc.entity,
    doc.issuedDate,
    doc.versionLabel,
    doc.topics.join(','),
    doc.references.map((r) => r.text).join(','),
  ].join('|');
}

/** Every document that may be one end of a relation, with its current fingerprint. */
function relatableFingerprints(): Map<string, DocumentDetail> {
  return new Map(relatableDocuments().map((doc) => [doc.documentId, doc]));
}

/**
 * Records that this document has now been compared against each of these, at the content
 * both ends had at the time. Written by `refreshCandidates`, which compares against the
 * whole library in one pass — so coverage arrives in bulk, per document.
 */
function recordCoverage(main: DocumentDetail, others: DocumentDetail[]): void {
  const db = getDb();
  const now = Date.now();
  const mainFingerprint = fingerprintOf(main);
  const insert = db.prepare(
    `INSERT INTO relation_coverage (from_document_id, to_document_id, from_fingerprint, to_fingerprint, computed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(from_document_id, to_document_id)
     DO UPDATE SET from_fingerprint = excluded.from_fingerprint,
                   to_fingerprint = excluded.to_fingerprint,
                   computed_at = excluded.computed_at`,
  );
  for (const other of others) {
    insert.run(main.documentId, other.documentId, mainFingerprint, fingerprintOf(other), now);
  }
}

/** The pairs this document has already been compared against, at which fingerprints. */
function coverageOf(documentId: string): Map<string, { from: string; to: string }> {
  const rows = getDb()
    .prepare(
      'SELECT to_document_id, from_fingerprint, to_fingerprint FROM relation_coverage WHERE from_document_id = ?',
    )
    .all(documentId) as Array<{ to_document_id: string; from_fingerprint: string; to_fingerprint: string }>;
  return new Map(rows.map((r) => [r.to_document_id, { from: r.from_fingerprint, to: r.to_fingerprint }]));
}

/**
 * Documents with at least one pair nobody has compared at the current content.
 *
 * This is the whole point of the ledger: "needs work" is now a QUESTION rather than a flag
 * somebody has to remember to set. A new document, an edited one, and one a previous sweep
 * ran out of budget before reaching are all the same answer, and none of them depends on a
 * write having happened at the right moment.
 */
export function uncoveredDocumentIds(limit = 50): string[] {
  // Removed documents are not in `relatableDocuments`, so they simply stop being asked
  // about. Their coverage rows are left alone on purpose: if the document comes back
  // unchanged, the comparison that was made about it still holds and re-running it would
  // buy nothing.
  const library = relatableFingerprints();
  const out: string[] = [];
  for (const [documentId, doc] of library) {
    const covered = coverageOf(documentId);
    const fingerprint = fingerprintOf(doc);
    for (const [otherId, other] of library) {
      if (otherId === documentId) continue;
      const row = covered.get(otherId);
      if (row && row.from === fingerprint && row.to === fingerprintOf(other)) continue;
      out.push(documentId);
      break;
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Recomputes and stores one document's shortlist. Deterministic and free of AI — this is
 * the half that can run for every document in a sync.
 */
export function refreshCandidates(mainDocumentId: string): Candidate[] {
  const main = getDocumentDetail(mainDocumentId);
  if (!main) return [];
  const library = relatableDocuments(mainDocumentId);
  const shortlist = gatherCandidates(main, library).filter(({ evidence }) => hasSignal(evidence));

  const db = getDb();
  const now = Date.now();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM relation_candidates WHERE from_document_id = ?').run(mainDocumentId);
    const insert = db.prepare(
      `INSERT INTO relation_candidates (from_document_id, to_document_id, score, evidence_json, computed_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const { candidate, evidence } of shortlist) {
      insert.run(mainDocumentId, candidate.documentId, evidence.semantic?.score ?? 0, JSON.stringify(evidence), now);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  // AFTER the commit, never before: coverage says a comparison happened, and a marker
  // written ahead of the thing it records is how a failed run reports success.
  recordCoverage(main, library);
  return shortlist;
}
