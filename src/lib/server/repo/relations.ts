import { ApiError } from '@/app/api/_helpers';
import { aiConfigured, aiStructured } from '@/lib/server/ai/client';
import { RELATION_JUDGEMENT_SCHEMA } from '@/lib/server/ai/schemas';
import { genId } from '@/lib/server/crypto';
import { getDb } from '@/lib/server/db';
import { excerptOnPage } from '@/lib/server/ingest/pages';
import { readSemanticProfile } from '@/lib/server/ingest/semantic-index';
import {
  deterministicRelevance,
  enforceRelationRules,
  type JudgedRelation,
  relationConfidence,
} from '@/lib/server/relations-rules';
import {
  hasExactSignal,
  isSemanticOnly,
  refreshCandidates,
  uncoveredDocumentIds,
  type Candidate,
  type CandidateEvidence,
} from '@/lib/server/repo/relation-candidates';
import { getDocumentDetail, type DocumentDetail } from '@/lib/server/repo/library';
import {
  inverseOf,
  isRelationType,
  isRelevance,
  STRONG_RELATION_TYPES,
  type Relevance,
  type RelationType,
} from '@/lib/types';

// Documental relations (briefing §9). The engine builds a deterministic shortlist from
// the app's own signals (exact references, verified title mentions, topic/entity/folder
// overlap), ONE AI call judges the type per candidate, and the app enforces the rule that
// strong types (altera/substitui) require an exact reference. Only user-CONFIRMED edges
// ever feed an analysis.

export type RelationRow = {
  relationId: string;
  fromDocumentId: string;
  toDocumentId: string;
  toDocumentName: string;
  type: RelationType;
  evidence: Record<string, unknown>;
  /**
   * How sure the app is the relation is REAL, derived from the evidence — a different
   * question from the relevância in `evidence`, and never a substitute for it.
   */
  confidence: { level: string; basis: string };
  proposedBy: 'engine' | 'ai' | 'user';
  status: 'proposed' | 'confirmed' | 'rejected';
  decidedAt: number | null;
  createdAt: number;
};

type DbRelationRow = {
  relation_id: string;
  from_document_id: string;
  to_document_id: string;
  to_name: string;
  type: RelationType;
  evidence_json: string;
  proposed_by: 'engine' | 'ai' | 'user';
  status: 'proposed' | 'confirmed' | 'rejected';
  decided_at: number | null;
  created_at: number;
};

/**
 * The band for a stored relation, from what its evidence records.
 *
 * Exported because the §5.3 gate reads the same `evidence_json` by a different route, and
 * the two must not be able to answer the question differently about the same edge.
 */
export function storedConfidence(
  evidence: Record<string, unknown>,
  proposedBy: 'engine' | 'ai' | 'user' = 'ai',
): { level: string; basis: string } {
  const stored = evidence.confidence as { level?: string; basis?: string } | undefined;
  if (stored?.level) return { level: stored.level, basis: String(stored.basis || '') };
  if (proposedBy === 'user') return relationConfidence({ ...NO_SIGNALS, manual: true });
  const deterministic = evidence.deterministic as CandidateEvidence | undefined;
  if (!deterministic) return relationConfidence(NO_SIGNALS);
  const citation = (evidence.ai as { citation?: { verified?: boolean } } | undefined)?.citation;
  return confidenceOf(deterministic, {
    verified: Boolean(citation?.verified),
    claimed: Boolean(citation),
  });
}

/** The band for a link a person asserted: the highest, because a person decided. */
export function manualConfidence(): { level: string; basis: string } {
  return relationConfidence({ ...NO_SIGNALS, manual: true });
}

const NO_SIGNALS = {
  exactReferenceHit: false,
  titleMention: false,
  aiEvidenceVerified: false,
  aiEvidenceClaimed: false,
  semanticOnly: false,
  manual: false,
};

function toRow(row: DbRelationRow): RelationRow {
  let evidence: Record<string, unknown> = {};
  try {
    evidence = JSON.parse(row.evidence_json) as Record<string, unknown>;
  } catch {
    evidence = {};
  }
  return {
    relationId: row.relation_id,
    fromDocumentId: row.from_document_id,
    toDocumentId: row.to_document_id,
    toDocumentName: row.to_name,
    type: row.type,
    evidence,
    // Derived on read for rows written before confidence existed, so an old proposal shows
    // the same honest band as a new one instead of a blank.
    confidence: storedConfidence(evidence, row.proposed_by),
    proposedBy: row.proposed_by,
    status: row.status,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

export function listRelations(documentId: string): RelationRow[] {
  const rows = getDb()
    .prepare(
      // `d.removed = 0` is the withdrawal (workstream F2). A relation to a document that
      // has left the library is not shown, not offered for confirmation and not counted —
      // enforced HERE rather than by a write on removal, because there are six places that
      // remove a document and a seventh would forget. The row is kept: if the document
      // comes back, so does the decision the user already made about it.
      `SELECT r.*, d.name AS to_name FROM relations r
       JOIN documents d ON d.document_id = r.to_document_id
       WHERE r.from_document_id = ? AND d.removed = 0
       ORDER BY CASE r.status WHEN 'confirmed' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END, r.created_at`,
    )
    .all(documentId) as DbRelationRow[];
  return rows.map(toRow);
}

export type DirectedRelationRow = RelationRow & {
  /** `outbound` — this document is the subject; `inbound` — the other one is. */
  direction: 'outbound' | 'inbound';
  otherDocumentId: string;
  otherDocumentName: string;
};

/**
 * Every edge touching this document, in both directions.
 *
 * An inbound edge is NOT flipped into its inverse. The 13 types already contain explicit
 * inverses (`altera` / `e_alterado_por`), so rewriting one as the other would assert a
 * second relation nobody judged — and the two are not interchangeable when only one of them
 * has exact evidence behind it. The direction is carried instead, and the UI reads an
 * inbound edge with the other document as the subject: «X» altera este documento.
 */
export function listRelationsBothWays(documentId: string): DirectedRelationRow[] {
  const rows = getDb()
    .prepare(
      // The union is wrapped because a compound SELECT may only be ordered by a plain
      // result column, and the ordering here is an expression over one.
      `SELECT * FROM (
         SELECT r.*, d.name AS to_name, 'outbound' AS direction, r.to_document_id AS other_id, d.name AS other_name
           FROM relations r JOIN documents d ON d.document_id = r.to_document_id
          WHERE r.from_document_id = ? AND d.removed = 0
         UNION ALL
         SELECT r.*, d.name AS to_name, 'inbound' AS direction, r.from_document_id AS other_id, s.name AS other_name
           FROM relations r
           JOIN documents d ON d.document_id = r.to_document_id
           JOIN documents s ON s.document_id = r.from_document_id
          WHERE r.to_document_id = ? AND s.removed = 0 AND d.removed = 0
       )
       ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END, created_at`,
    )
    .all(documentId, documentId) as Array<DbRelationRow & { direction: 'outbound' | 'inbound'; other_id: string; other_name: string }>;
  return rows.map((row) => ({
    ...toRow(row),
    direction: row.direction,
    otherDocumentId: row.other_id,
    otherDocumentName: row.other_name,
  }));
}

/**
 * Decides the RELATION, which is the pair — not one of the motives under it.
 *
 * The user judges "are these two documents related", once. Every motive recorded between
 * them is part of that one answer, so a pair whose motives could hold different statuses
 * would be a pair the app could describe two ways at the same time.
 */
/** The order the bands rank in when a pair carries more than one motive. */
const CONFIDENCE_ORDER = ['alta', 'media', 'baixa', 'nao_confirmada'];

export type RelationMotive = {
  relationId: string;
  type: RelationType;
  /** `outbound` — this document is the subject; `inbound` — the other one is. */
  direction: 'outbound' | 'inbound';
  confidence: { level: string; basis: string };
  status: 'proposed' | 'confirmed' | 'rejected';
  proposedBy: 'engine' | 'ai' | 'user';
  evidence: Record<string, unknown>;
};

export type RelationGroup = {
  /** The pair IS the relation, so the id of any one motive would be an arbitrary choice. */
  relationId: string;
  otherDocumentId: string;
  otherDocumentName: string;
  status: 'proposed' | 'confirmed' | 'rejected';
  /** The strongest band among the motives — the best reason to believe the pair is real. */
  confidence: { level: string; basis: string };
  motives: RelationMotive[];
  createdAt: number;
  decidedAt: number | null;
};

/**
 * The relations of a document, ONE PER OTHER DOCUMENT.
 *
 * Two documents are related or they are not; the types are the reasons why. The library
 * used to show one card per stored edge, so a pair whose link was found from both sides
 * appeared twice, saying the same thing in two grammatical directions and asking to be
 * confirmed twice. Now the pair is the card and the types are tags on it.
 *
 * A motive keeps its own direction and is never flipped into its inverse: «X é alterado por
 * este documento» is not «este documento altera X» when only one of the two has evidence.
 */
export function listRelationGroups(documentId: string): RelationGroup[] {
  const groups = new Map<string, RelationGroup>();
  for (const row of listRelationsBothWays(documentId)) {
    const motive: RelationMotive = {
      relationId: row.relationId,
      type: row.type,
      direction: row.direction,
      confidence: row.confidence,
      status: row.status,
      proposedBy: row.proposedBy,
      evidence: row.evidence,
    };
    const existing = groups.get(row.otherDocumentId);
    if (!existing) {
      groups.set(row.otherDocumentId, {
        relationId: row.relationId,
        otherDocumentId: row.otherDocumentId,
        otherDocumentName: row.otherDocumentName,
        status: row.status,
        confidence: row.confidence,
        motives: [motive],
        createdAt: row.createdAt,
        decidedAt: row.decidedAt,
      });
      continue;
    }
    // Motives are deduplicated by type: the same reason recorded from both sides is one
    // reason, and the inverse of a type is the same reason phrased from the other end.
    if (!existing.motives.some((m) => m.type === row.type || m.type === inverseOf(row.type))) {
      existing.motives.push(motive);
    }
    // Legacy rows can disagree, because a decision used to be per edge. A pair anyone
    // confirmed is confirmed; one every motive was rejected on is rejected.
    if (row.status === 'confirmed') existing.status = 'confirmed';
    else if (existing.status === 'rejected' && row.status === 'proposed') existing.status = 'proposed';
    if (CONFIDENCE_ORDER.indexOf(row.confidence.level) < CONFIDENCE_ORDER.indexOf(existing.confidence.level)) {
      existing.confidence = row.confidence;
    }
    existing.createdAt = Math.min(existing.createdAt, row.createdAt);
    existing.decidedAt = existing.decidedAt ?? row.decidedAt;
  }
  return [...groups.values()].sort(
    (a, b) =>
      ['confirmed', 'proposed', 'rejected'].indexOf(a.status) - ['confirmed', 'proposed', 'rejected'].indexOf(b.status) ||
      a.createdAt - b.createdAt,
  );
}

export function decideRelation(relationId: string, decision: 'confirmed' | 'rejected'): RelationRow {
  const db = getDb();
  const target = db
    .prepare('SELECT from_document_id, to_document_id FROM relations WHERE relation_id = ?')
    .get(relationId) as { from_document_id: string; to_document_id: string } | undefined;
  if (!target) throw new ApiError('Relation not found.', 404);
  const res = db
    .prepare(
      `UPDATE relations SET status = ?, decided_at = ?, updated_at = ?
        WHERE (from_document_id = ? AND to_document_id = ?)
           OR (from_document_id = ? AND to_document_id = ?)`,
    )
    .run(
      decision,
      Date.now(),
      Date.now(),
      target.from_document_id,
      target.to_document_id,
      target.to_document_id,
      target.from_document_id,
    );
  if (Number(res.changes) === 0) throw new ApiError('Relation not found.', 404);
  const row = db
    .prepare(
      `SELECT r.*, d.name AS to_name FROM relations r
       JOIN documents d ON d.document_id = r.to_document_id WHERE r.relation_id = ?`,
    )
    .get(relationId) as DbRelationRow;
  return toRow(row);
}

export function addManualRelation(fromDocumentId: string, toDocumentId: string, type: RelationType): RelationRow {
  if (!isRelationType(type)) throw new ApiError('Unknown relation type.', 400);
  if (fromDocumentId === toDocumentId) throw new ApiError('A document cannot relate to itself.', 400);
  const db = getDb();
  if (!getDocumentDetail(toDocumentId)) throw new ApiError('Target document not found.', 404);
  const now = Date.now();
  const relationId = genId('rel');
  db.prepare(
    `INSERT INTO relations (relation_id, from_document_id, to_document_id, type, evidence_json, proposed_by, status, decided_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'user', 'confirmed', ?, ?, ?)
     ON CONFLICT(from_document_id, to_document_id, type)
     DO UPDATE SET status = 'confirmed', proposed_by = 'user', decided_at = excluded.decided_at, updated_at = excluded.updated_at`,
  ).run(
    relationId,
    fromDocumentId,
    toDocumentId,
    type,
    JSON.stringify({ manual: true, confidence: relationConfidence({ ...NO_SIGNALS, manual: true }) }),
    now,
    now,
    now,
  );
  const row = db
    .prepare(
      `SELECT r.*, d.name AS to_name FROM relations r
       JOIN documents d ON d.document_id = r.to_document_id
       WHERE r.from_document_id = ? AND r.to_document_id = ? AND r.type = ?`,
    )
    .get(fromDocumentId, toDocumentId, type) as DbRelationRow;
  return toRow(row);
}

/**
 * Any edge at all between these two, IN EITHER DIRECTION, whatever its type or status.
 *
 * The direction used to be part of the question, and that is what put every pair in the
 * library twice: the sweep proposes A→B while processing A, then B→A while processing B,
 * and «A cita B» and «B é citado por A» are one fact written down twice. A rejected edge
 * counts too — the user has answered for this pair and the sweep must not ask again.
 */
function relationExists(fromDocumentId: string, toDocumentId: string): boolean {
  // Deliberately does NOT filter removed: a rejected edge to a document that later came
  // back is still an answer the user gave, and asking again would be asking twice.
  const row = getDb()
    .prepare(
      `SELECT 1 FROM relations
        WHERE (from_document_id = ? AND to_document_id = ?)
           OR (from_document_id = ? AND to_document_id = ?) LIMIT 1`,
    )
    .get(fromDocumentId, toDocumentId, toDocumentId, fromDocumentId);
  return Boolean(row);
}

/** The app's own confidence for a candidate, from the evidence it gathered itself. */
function confidenceOf(
  evidence: CandidateEvidence,
  ai: { verified: boolean; claimed: boolean } = { verified: false, claimed: false },
): { level: string; basis: string } {
  return relationConfidence({
    exactReferenceHit: evidence.referenceHits.length > 0,
    titleMention: evidence.titleMentions.length > 0,
    aiEvidenceVerified: ai.verified,
    aiEvidenceClaimed: ai.claimed && !ai.verified,
    semanticOnly: isSemanticOnly(evidence),
    manual: false,
  });
}

/** The app's own relevance band for a candidate, from the evidence it gathered itself. */
function relevanceOf(evidence: CandidateEvidence, type: string): Relevance {
  return deterministicRelevance({
    exactReferenceHit: evidence.referenceHits.length > 0,
    titleMention: evidence.titleMentions.length > 0,
    topicOverlap: evidence.topicOverlap.length,
    entityMatch: evidence.entityMatch,
    sameFolder: evidence.sameFolder,
    semanticRank: evidence.semantic?.rank ?? null,
    strongType: STRONG_RELATION_TYPES.includes(type as RelationType),
  });
}

// --- Proposal engine -------------------------------------------------------

function candidateBrief(doc: DocumentDetail, evidence: CandidateEvidence): string {
  return [
    `candidate id: ${doc.documentId}`,
    `name: ${doc.name} | title: ${doc.title} | type: ${doc.docType} | issued: ${doc.issuedDate || '—'} | version: ${doc.versionLabel || '—'}`,
    `topics: ${doc.topics.join(', ')}`,
    // §7.9's profile, written by the classification call. Topics are the words on the page;
    // concepts are what the document is about — which is what "does this alter that?" is
    // actually a question about, and what stops a candidate shortlisted by closeness alone
    // from being judged on its filename.
    profileLine(doc.documentId),
    `evidence found by the app: ${JSON.stringify(evidence)}`,
  ].join('\n');
}

/** One line of the semantic profile, or nothing at all if the document has none yet. */
function profileLine(documentId: string): string {
  const profile = readSemanticProfile(documentId);
  const parts = [
    profile.concepts.length ? `concepts: ${profile.concepts.join('; ')}` : '',
    profile.synonyms.length ? `also called: ${profile.synonyms.join('; ')}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' | ') : 'concepts: —';
}

export type ProposalRun = {
  shortlisted: number;
  proposed: number;
  judged: boolean; // false = degraded heuristic run (no AI)
  enforced: number; // strong claims downgraded by the rule
};

export async function proposeRelations(mainDocumentId: string, precomputed?: Candidate[]): Promise<ProposalRun> {
  const main = getDocumentDetail(mainDocumentId);
  if (!main) throw new ApiError('Document not found.', 404);

  // The shortlist is RECOMPUTED, not read back from the cache, unless the caller has just
  // computed it. Asking for relations is asking about the document as it is now, and its
  // metadata changes after processing — the classifier writes references, the user corrects
  // a title — each of which changes who its candidates are. Refreshing costs milliseconds
  // and updates the cache on the way through; reading a stale shortlist would quietly
  // answer a question about the document as it used to be.
  const withEvidence = precomputed ?? refreshCandidates(mainDocumentId);

  const db = getDb();
  const now = Date.now();
  const canJudge = await aiConfigured();
  let proposed = 0;
  let enforcedCount = 0;

  const upsert = db.prepare(
    `INSERT INTO relations (relation_id, from_document_id, to_document_id, type, evidence_json, proposed_by, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?)
     ON CONFLICT(from_document_id, to_document_id, type) DO UPDATE SET
       evidence_json = excluded.evidence_json, updated_at = excluded.updated_at
     WHERE relations.status = 'proposed'`,
  );

  if (!canJudge) {
    // Degraded run: deterministic evidence only, conservative types, marked as heuristic.
    for (const { candidate, evidence } of withEvidence) {
      const fromCites = evidence.referenceHits.some((h) => h.direction === 'from_cites_to');
      const toCites =
        evidence.referenceHits.some((h) => h.direction === 'to_cites_from') || evidence.titleMentions.length > 0;
      const types: RelationType[] = [];
      if (fromCites) types.push('cita');
      if (toCites) types.push('e_citado_por');
      if (types.length === 0) types.push('trata_o_mesmo_tema');
      for (const type of types) {
        upsert.run(
          genId('rel'),
          mainDocumentId,
          candidate.documentId,
          type,
          JSON.stringify({
            deterministic: evidence,
            relevance: relevanceOf(evidence, type),
            confidence: confidenceOf(evidence),
            heuristic: 'sem julgamento AI — proposta pelas evidências da aplicação',
          }),
          'engine',
          now,
          now,
        );
        proposed += 1;
      }
    }
    return { shortlisted: withEvidence.length, proposed, judged: false, enforced: 0 };
  }

  if (withEvidence.length === 0) {
    return { shortlisted: 0, proposed: 0, judged: true, enforced: 0 };
  }

  const mainPageOne = String(
    (db.prepare('SELECT text FROM document_pages WHERE document_id = ? AND page = 1').get(mainDocumentId) as
      | { text: string }
      | undefined)?.text || '',
  ).slice(0, 1500);

  const result = await aiStructured<{ relations: JudgedRelation[] }>({
    task: 'judge_document_relations',
    instructions: [
      'Judge the documental relation between the MAIN document and each CANDIDATE, choosing exactly one type per candidate from the schema enum. The type reads MAIN → CANDIDATE (e.g. "altera" means the MAIN document alters the candidate).',
      'Base every judgement ONLY on the provided evidence and excerpts. When your judgement rests on a specific passage, cite it (document id, page, verbatim excerpt); otherwise leave the evidence fields empty/0.',
      'Strong types (altera, substitui and their inverses) are only warranted by explicit textual references — when in doubt, prefer a weaker type.',
      'Some candidates were shortlisted only because they are semantically close to the main document. A closeness score is not evidence of anything: for those, judge from the excerpts alone and expect a weak type.',
      `MAIN document: id ${main.documentId} | ${main.name} | title: ${main.title} | type: ${main.docType} | issued: ${main.issuedDate || '—'} | topics: ${main.topics.join(', ')}`,
      `MAIN references: ${JSON.stringify(main.references)}`,
      `MAIN ${profileLine(main.documentId)}`,
      `MAIN first page (excerpt): ${mainPageOne}`,
    ].join('\n'),
    input: [
      {
        type: 'input_text',
        text: withEvidence.map(({ candidate, evidence }) => candidateBrief(candidate, evidence)).join('\n\n'),
      },
    ],
    schema: RELATION_JUDGEMENT_SCHEMA,
    reasoningEffort: 'medium',
  });

  const evidenceByCandidate = new Map(withEvidence.map(({ candidate, evidence }) => [candidate.documentId, evidence]));
  for (const judged of result.relations) {
    const deterministic = evidenceByCandidate.get(judged.to_document_id);
    if (!deterministic) continue; // hallucinated candidate id — never store it
    const aiEvidenceVerified = Boolean(
      judged.evidence_document_id &&
        judged.evidence_page > 0 &&
        judged.evidence_excerpt &&
        excerptOnPage(judged.evidence_document_id, judged.evidence_page, judged.evidence_excerpt),
    );
    const enforced = enforceRelationRules(judged, {
      exactReferenceHit: hasExactSignal(deterministic),
      aiEvidenceVerified,
      semanticOnly: isSemanticOnly(deterministic),
    });
    if (enforced.enforced) enforcedCount += 1;
    if (!isRelationType(enforced.type)) continue;
    upsert.run(
      genId('rel'),
      mainDocumentId,
      judged.to_document_id,
      enforced.type,
      JSON.stringify({
        deterministic,
        // The model's band when it gave one, the app's own otherwise. §5.3 shows the user a
        // relevância for every candidate, including on the no-AI path, so it can never be
        // something only a model can produce.
        relevance: isRelevance(judged.relevance) ? judged.relevance : relevanceOf(deterministic, enforced.type),
        // Confiança is DERIVED, always — never taken from the model, which is not asked for
        // it. Relevância may come from the model; certainty about the link may not.
        confidence: confidenceOf(deterministic, {
          verified: aiEvidenceVerified,
          claimed: Boolean(judged.evidence_document_id),
        }),
        ai: {
          rationale: enforced.rationale,
          citation: judged.evidence_document_id
            ? { documentId: judged.evidence_document_id, page: judged.evidence_page, excerpt: judged.evidence_excerpt, verified: aiEvidenceVerified }
            : null,
        },
        ...(enforced.enforced ? { enforcementNote: enforced.enforcementNote } : {}),
      }),
      'ai',
      now,
      now,
    );
    proposed += 1;
  }

  return { shortlisted: withEvidence.length, proposed, judged: true, enforced: enforcedCount };
}

/**
 * One relation pass over everything a sync touched (§7 step 10).
 *
 * Called when the ingest queue drains, not per document. The deterministic shortlist is
 * recomputed for every dirty document — cheap, no AI, and it reads the library's vectors
 * once. The JUDGEMENT is one call per document that actually has candidates, and that is
 * the real budget: a document with nothing to relate to costs nothing at all.
 */
export async function sweepRelations(): Promise<{ documents: number; proposed: number }> {
  const pending = uncoveredDocumentIds();
  let proposed = 0;
  for (const documentId of pending) {
    try {
      // `refreshCandidates` records the coverage itself, on commit. A judgement that fails
      // afterwards must not make the sweep re-judge this document on every sync forever —
      // the comparison DID happen, which is what coverage records.
      const shortlist = refreshCandidates(documentId);
      // Coverage drives the CHEAP half. Judging on it too would mean one AI call per
      // document in the library per sync, so the judgement asks a narrower question: has
      // this document acquired a candidate nobody has judged yet? A sync that adds one file
      // leaves the other 499 shortlists refreshed and unjudged, which is exactly right —
      // their edges already exist and re-judging would only spend money to reach the same
      // answer.
      if (shortlist.some(({ candidate }) => !relationExists(documentId, candidate.documentId))) {
        proposed += (await proposeRelations(documentId, shortlist)).proposed;
      }
    } catch (error) {
      console.warn(
        `[legal] Relation sweep for ${documentId} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { documents: pending.length, proposed };
}
