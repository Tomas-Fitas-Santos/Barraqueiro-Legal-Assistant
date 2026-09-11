// The §10 fields an extraction carries, and what they are called in the client's language.
//
// This list used to live inside the review component, which made it the review component's
// private business — and it is not: the JSON export is rendered from the same fields, on the
// server, and it must call them what the review screen calls them or the same extraction
// reads as two different documents. Declared once, client-safe, no server imports.
//
// D3 will make the .json TEMPLATE the source of this list. Until then it is at least a
// single list rather than one per surface.

export type FieldSpec = [key: string, label: string];

/** The §10 statement fields, in the order the briefing lists them. */
export const STATEMENT_FIELDS: FieldSpec[] = [
  ['topic', 'Tema'],
  ['scope', 'Âmbito de aplicação'],
  ['entity', 'Entidades abrangidas'],
  ['required_action', 'Medidas a implementar'],
  ['suggested_owner', 'Responsável sugerido'],
  ['deadline', 'Data ou prazo'],
  ['consequence', 'Consequência'],
  ['exceptions', 'Exceções'],
];

/** The comparison matrix of a revision analysis. */
export const MATRIX_FIELDS: FieldSpec[] = [
  ['topic', 'Tema'],
  ['current_content', 'Documento atual'],
  ['related_content', 'Documento relacionado'],
  ['difference', 'Diferença'],
  ['proposed_change', 'Alteração proposta'],
  ['impact', 'Impacto'],
];

export function fieldsForKind(kind: string): FieldSpec[] {
  return kind === 'matrix_row' ? MATRIX_FIELDS : STATEMENT_FIELDS;
}

/**
 * Confiança (§2.2), derived from the evidence quality the model reported — never a second
 * self-reported field, which would let the model contradict itself.
 */
export function confidenceLabel(evidenceQuality: string): string {
  switch (evidenceQuality) {
    case 'direct':
      return 'Confiança alta';
    case 'indirect':
      return 'Confiança média';
    case 'ambiguous':
      return 'Confiança baixa';
    default:
      return 'Não confirmada';
  }
}
