// The app-enforced relation rules (briefing §9) as PURE functions — a LEAF module (no
// imports) so the unit suite exercises exactly the shipped logic. The AI judges; these
// rules decide what the judgement is allowed to conclude.

// Mirrors STRONG_RELATION_TYPES in src/lib/types.ts (kept literal here to stay leaf).
const STRONG = ['substitui', 'e_substituido_por', 'altera', 'e_alterado_por'];

export type JudgedRelation = {
  to_document_id: string;
  type: string;
  rationale: string;
  relevance: string;
  evidence_document_id: string;
  evidence_page: number;
  evidence_excerpt: string;
};

export type DeterministicEvidence = {
  // Exact reference hits found by the app itself (classification references or verified
  // title mentions) between the main document and this candidate, either direction. Named
  // `exact` so that there is no field on this type a similarity score could be handed to.
  exactReferenceHit: boolean;
  // Whether the AI's own cited evidence excerpt was verified against the page store.
  aiEvidenceVerified: boolean;
  // True when the ONLY thing that put this candidate on the shortlist was semantic
  // similarity. §9 is explicit that similarity alone may never conclude altera/substitui,
  // and this is the flag that makes it structural rather than a convention.
  semanticOnly?: boolean;
};

export type EnforcedRelation = JudgedRelation & {
  enforced: boolean; // true when the rule changed the AI's conclusion
  enforcementNote: string;
};

/**
 * Strong types (altera/substitui, both directions) require an EXACT reference: either a
 * deterministic reference hit the app found itself, or an AI-cited excerpt the app
 * verified on the page store. Similarity or rationale alone never suffices — a strong
 * claim without that support is downgraded to "trata_o_mesmo_tema" and marked, never
 * silently accepted or silently dropped.
 */
export function enforceRelationRules(
  judged: JudgedRelation,
  evidence: DeterministicEvidence,
): EnforcedRelation {
  if (!STRONG.includes(judged.type)) {
    return { ...judged, enforced: false, enforcementNote: '' };
  }
  if (evidence.semanticOnly) {
    return {
      ...judged,
      type: 'trata_o_mesmo_tema',
      enforced: true,
      // Deliberately checked BEFORE aiEvidenceVerified. A verified excerpt proves only that
      // those words are on that page — when the app's own reference matcher found nothing
      // tying these two documents together, nothing proves the excerpt is ABOUT the
      // candidate, and that is precisely the inference §9 forbids similarity from making.
      enforcementNote:
        `Reclassificado pela aplicação: "${judged.type}" foi proposto apenas por semelhança semântica, sem qualquer referência exata — a semelhança pode sugerir uma relação, nunca concluir que um documento altera ou substitui outro (regra do briefing §9).`,
    };
  }
  if (evidence.exactReferenceHit || evidence.aiEvidenceVerified) {
    return { ...judged, enforced: false, enforcementNote: '' };
  }
  return {
    ...judged,
    type: 'trata_o_mesmo_tema',
    enforced: true,
    enforcementNote:
      `Reclassificado pela aplicação: "${judged.type}" exige uma referência exata verificada, que não existe — a semelhança não basta (regra do briefing §9).`,
  };
}

/** §5.3's relevância. An enum, not a number — see RELEVANCE_LABELS in @/lib/types. */
export type Relevance = 'alta' | 'media' | 'baixa';

export type RelevanceSignals = {
  exactReferenceHit: boolean;
  titleMention: boolean;
  topicOverlap: number;
  entityMatch: boolean;
  sameFolder: boolean;
  /** Rank among the library by similarity, 1 = closest. Null when nothing is indexed. */
  semanticRank: number | null;
  strongType: boolean;
};

/**
 * The band the APP can justify from its own evidence, with no model involved.
 *
 * §5.3 asks the user to confirm each related document individually, and a band with nothing
 * behind it is worse than no band — it would launder a guess into a recommendation. So this
 * is deliberately conservative: only evidence the app found in the TEXT reaches "alta".
 * It is also what the no-AI path shows, which is why it lives here rather than in a prompt.
 */
export function deterministicRelevance(signals: RelevanceSignals): Relevance {
  if (signals.exactReferenceHit || signals.strongType) return 'alta';
  if (signals.titleMention) return 'alta';
  if (signals.topicOverlap >= 2 || (signals.topicOverlap >= 1 && (signals.entityMatch || signals.sameFolder))) {
    return 'media';
  }
  if (signals.semanticRank !== null && signals.semanticRank <= 2) return 'media';
  return 'baixa';
}

// --- Confiança -------------------------------------------------------------

/**
 * How sure the app is that the relation is REAL AT ALL.
 *
 * Not the same axis as relevância, and the two must never stand in for each other:
 * relevância says how much this document would change an analysis, confiança says whether
 * the link exists. A semantically-close document can be highly relevant and, at the same
 * time, something the app has no evidence for — which is exactly the case a single band
 * would hide.
 *
 * Derived from the evidence, never a second self-reported field. That is the same rule the
 * extraction already follows: asking the model for its own confidence alongside the
 * evidence lets it contradict itself, and the contradiction is invisible.
 */
export type RelationConfidence = 'alta' | 'media' | 'baixa' | 'nao_confirmada';

export type ConfidenceSignals = {
  /** The other document is cited in this one's text — the app matched the reference. */
  exactReferenceHit: boolean;
  /** Its title appears verbatim in the text. */
  titleMention: boolean;
  /** The model cited a passage AND the app found that passage on that page. */
  aiEvidenceVerified: boolean;
  /** The model cited a passage that is NOT on the page it named. */
  aiEvidenceClaimed: boolean;
  /** Similarity is the only reason this pair was ever looked at. */
  semanticOnly: boolean;
  /** A person asserted this relation instead of the app proposing it. */
  manual: boolean;
};

export function relationConfidence(signals: ConfidenceSignals): { level: RelationConfidence; basis: string } {
  // A person deciding is not a weaker form of evidence than a string match — it is the
  // thing every proposal is trying to approximate.
  if (signals.manual) return { level: 'alta', basis: 'Relação indicada por si.' };
  if (signals.exactReferenceHit) {
    return { level: 'alta', basis: 'O documento é citado no texto do outro.' };
  }
  if (signals.aiEvidenceVerified) {
    return { level: 'alta', basis: 'A passagem citada foi encontrada na página indicada.' };
  }
  if (signals.titleMention) {
    return { level: 'media', basis: 'O título do documento aparece no texto do outro.' };
  }
  // A citation the app could NOT find is worse than no citation: something was asserted and
  // did not check out, so it lowers confidence rather than leaving it untouched.
  if (signals.aiEvidenceClaimed) {
    return { level: 'baixa', basis: 'A passagem citada não foi encontrada na página indicada.' };
  }
  if (signals.semanticOnly) {
    return { level: 'nao_confirmada', basis: 'Apenas semelhança de assunto, sem qualquer referência no texto.' };
  }
  return { level: 'baixa', basis: 'Indícios de tema, entidade ou localização, sem referência no texto.' };
}
