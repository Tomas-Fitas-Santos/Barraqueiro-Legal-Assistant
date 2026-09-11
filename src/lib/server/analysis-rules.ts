// The §11 citation validators as PURE functions — a LEAF module (no imports) so the unit
// suite (including the poisoned-run test) exercises exactly the shipped logic. The
// db-bound wrapper in repo/analyses.ts supplies the context facts; these rules decide.

export type SourcedItem = {
  statement_type?: string; // statements
  relationship_type?: string; // matrix lines
  content?: string;
  related_content?: string;
  deadline?: string;
  source_document_id: string;
  source_page: number;
  source_excerpt: string;
  evidence_quality: string;
  ai_suggestion: boolean;
};

export type ValidationContext = {
  // Is the cited source among the CONFIRMED documents of this analysis?
  sourceConfirmed: boolean;
  // Does the cited document exist in the library at all? (an unknown id = invented source)
  sourceExists: boolean;
  // Does the cited page exist in that document?
  pageExists: boolean;
  // Is the cited excerpt really on that page? (whitespace/case-insensitive containment)
  excerptOnPage: boolean;
};

export type ItemVerdict = { accepted: true } | { accepted: false; reason: string };

function isObligationLike(item: SourcedItem): boolean {
  const type = String(item.statement_type || '');
  return type === 'obligation' || type === 'deadline' || Boolean(String(item.deadline || '').trim());
}

function hasCitation(item: SourcedItem): boolean {
  return Boolean(item.source_document_id) || item.source_page > 0 || Boolean(item.source_excerpt);
}

/**
 * §11, verbatim as code. Order matters: invented sources are the gravest failure, then
 * unconfirmed sources, then page/excerpt fabrication; the no-source cases close the list.
 * AI suggestions are allowed WITHOUT a citation (they are visibly marked, not facts) but
 * any citation they do carry must still be real — a fabricated citation on a suggestion
 * is still a fabricated citation.
 */
export function validateAnalysisItem(item: SourcedItem, ctx: ValidationContext): ItemVerdict {
  if (hasCitation(item)) {
    if (!item.source_document_id || !ctx.sourceExists) {
      return { accepted: false, reason: 'Fonte inventada: o documento citado não existe na biblioteca.' };
    }
    if (!ctx.sourceConfirmed) {
      return { accepted: false, reason: 'Fonte fora do conjunto confirmado para esta análise.' };
    }
    if (item.source_page <= 0 || !ctx.pageExists) {
      return { accepted: false, reason: `Página citada (${item.source_page}) não existe no documento.` };
    }
    if (!item.source_excerpt || !ctx.excerptOnPage) {
      return { accepted: false, reason: 'Excerto citado não foi encontrado na página indicada.' };
    }
    return { accepted: true };
  }

  // No citation at all.
  if (item.ai_suggestion) return { accepted: true }; // marked suggestion, never a fact
  if (isObligationLike(item)) {
    return { accepted: false, reason: 'Obrigação ou prazo apresentado sem fonte — rejeitado (§11).' };
  }
  if (item.evidence_quality !== 'not_confirmed') {
    return {
      accepted: false,
      reason: 'Afirmação factual sem fonte tem de ser marcada como não confirmada, nunca apresentada como facto.',
    };
  }
  return { accepted: true }; // honest not_confirmed
}
