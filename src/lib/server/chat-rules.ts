// The §13 confirmation-gate rules as PURE functions — a LEAF module (no imports) so the
// unit suite (including the under-reporting-model test) exercises exactly the shipped
// logic. The model self-assesses its change; the APP diffs the narratives itself and the
// stricter verdict always wins.

export type NarrativeSectionShape = { heading: string; body: string };

export type ModelImpact = {
  removes_factual_content: boolean;
  alters_obligations_deadlines_references: boolean;
  requires_confirmation: boolean;
};

export type CrossCheck = {
  gate: boolean;
  removedMarkers: number[];
  appOverrode: boolean; // the app gated a change the model claimed was harmless
  reasons: string[];
};

export function extractMarkers(sections: NarrativeSectionShape[]): Set<number> {
  const markers = new Set<number>();
  for (const section of sections) {
    for (const match of section.body.matchAll(/\[(\d{1,3})\]/g)) {
      markers.add(Number(match[1]));
    }
  }
  return markers;
}

/**
 * §13: explicit confirmation is mandatory before removing an obligation, removing or
 * altering a deadline, deleting a reference, excluding a used source, converting a fact
 * into a recommendation, or replacing sourced content. All of those necessarily drop or
 * displace CITED content — so any reference marker present before and absent after is a
 * deterministic gate, regardless of what the model claims about its own change.
 */
export function crossCheckProposal(
  oldSections: NarrativeSectionShape[],
  newSections: NarrativeSectionShape[],
  modelImpact: ModelImpact,
): CrossCheck {
  const before = extractMarkers(oldSections);
  const after = extractMarkers(newSections);
  const removedMarkers = [...before].filter((n) => !after.has(n)).sort((a, b) => a - b);

  const modelGate =
    modelImpact.requires_confirmation ||
    modelImpact.removes_factual_content ||
    modelImpact.alters_obligations_deadlines_references;
  const appGate = removedMarkers.length > 0;

  const reasons: string[] = [];
  if (modelImpact.removes_factual_content) reasons.push('Remove conteúdo factual.');
  if (modelImpact.alters_obligations_deadlines_references) reasons.push('Altera obrigações, prazos ou referências.');
  if (modelImpact.requires_confirmation && reasons.length === 0) reasons.push('O modelo pediu confirmação explícita.');
  if (appGate) {
    reasons.push(
      `A aplicação detetou a remoção de conteúdo com fonte: referência(s) [${removedMarkers.join('], [')}] deixaram de ser citadas.`,
    );
  }

  return {
    gate: modelGate || appGate,
    removedMarkers,
    appOverrode: appGate && !modelGate,
    reasons,
  };
}

// --- §13 over the structured output ------------------------------------------------------
//
// The same six operations, applied to the extraction rather than the narrative. On a
// narrative the app can only see cited content disappearing; on the structured output it
// can see EXACTLY which obligation, which deadline, which source — so the check is
// item-by-item and names what is being lost.

export type ExtractionItemShape = {
  statement_type?: string;
  content?: string;
  deadline?: string;
  source_document_id?: string;
  source_page?: number;
  source_excerpt?: string;
  ai_suggestion?: boolean;
  requires_legal_decision?: boolean;
  topic?: string;
  difference?: string;
  proposed_change?: string;
};

export type ExtractionCheck = {
  gate: boolean;
  reasons: string[];
};

function isObligation(item: ExtractionItemShape): boolean {
  return item.statement_type === 'obligation' || item.statement_type === 'deadline';
}

function hasSource(item: ExtractionItemShape): boolean {
  return Boolean(item.source_document_id) && Number(item.source_page || 0) > 0;
}

function describe(item: ExtractionItemShape, index: number): string {
  const text = String(item.content || item.topic || item.difference || '').trim();
  return text ? `“${text.slice(0, 60)}${text.length > 60 ? '…' : ''}”` : `item ${index + 1}`;
}

/**
 * §13 on a hand-edited extraction: explicit confirmation is mandatory before removing an
 * obligation, removing or altering a deadline, deleting a reference, excluding a used
 * source, turning a documented fact into a recommendation, or replacing sourced content.
 *
 * Items are compared position by position, which is what the editor produces — it returns
 * the whole artifact with the same items in the same order, edited in place.
 */
export function crossCheckExtractionEdit(
  before: ExtractionItemShape[],
  after: ExtractionItemShape[],
): ExtractionCheck {
  const reasons: string[] = [];

  // Removing an item outright.
  if (after.length < before.length) {
    const dropped = before.slice(after.length);
    const obligations = dropped.filter(isObligation).length;
    reasons.push(
      obligations > 0
        ? `Remove ${dropped.length} item(ns), ${obligations} do(s) qual(is) obrigações ou prazos.`
        : `Remove ${dropped.length} item(ns) da extração.`,
    );
  }

  before.forEach((old, index) => {
    const now = after[index];
    if (!now) return;

    if (isObligation(old) && String(now.content || '').trim() === '') {
      reasons.push(`Remove a obrigação ${describe(old, index)}.`);
    }
    if (String(old.deadline || '') && String(old.deadline) !== String(now.deadline || '')) {
      reasons.push(
        String(now.deadline || '')
          ? `Altera o prazo de ${describe(old, index)}: "${old.deadline}" → "${now.deadline}".`
          : `Remove o prazo de ${describe(old, index)} ("${old.deadline}").`,
      );
    }
    if (hasSource(old) && !hasSource(now)) {
      reasons.push(`Elimina a fonte citada por ${describe(old, index)}.`);
    } else if (hasSource(old) && old.source_document_id !== now.source_document_id) {
      reasons.push(`Substitui a fonte de ${describe(old, index)} por outro documento.`);
    }
    if (old.ai_suggestion !== true && now.ai_suggestion === true) {
      reasons.push(`Transforma ${describe(old, index)}, um facto documental, numa recomendação.`);
    }
    // Replacing sourced content: the text backed by an excerpt is rewritten while the
    // excerpt it rests on stays the same, so the citation would no longer support it.
    if (
      hasSource(old) &&
      String(old.content || '') !== String(now.content || '') &&
      String(old.source_excerpt || '') === String(now.source_excerpt || '') &&
      String(now.content || '').trim() !== ''
    ) {
      reasons.push(`Reescreve ${describe(old, index)}, que está suportado por uma fonte citada.`);
    }
  });

  return { gate: reasons.length > 0, reasons };
}
