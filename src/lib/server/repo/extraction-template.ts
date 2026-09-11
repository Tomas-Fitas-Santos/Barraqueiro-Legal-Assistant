import { createHash } from 'node:crypto';

import { ApiError } from '@/app/api/_helpers';
import { getSetting, setSetting } from '@/lib/server/db';
import type { AnalysisType } from '@/lib/types';

// What the agent is asked to extract — as data the client can change, not code we deploy.
//
// The shape of an extraction lived in three places that had to agree by hand: the AI schema,
// the validators, and the review screen's field list. Adding a field meant editing all three
// and shipping. This makes ONE of those the source: the template says which content fields
// exist and what each one means, and the schema and the review screen are derived from it.
//
// THE GROUNDING SPINE IS NOT IN HERE, deliberately. `source_document_id`, `source_page`,
// `source_excerpt`, `evidence_quality`, `ai_suggestion` and the type enums are §10/§11 — the
// validators rest on them, and a template that could delete them would be a template that
// could switch off citation checking. The client owns WHAT IS ASKED; the app owns HOW THE
// ANSWER MUST BE PROVEN. A field added here is subject to exactly the same contract: the
// model may only fill it from a document, page and excerpt, or the item is not confirmed.

export type ExtractionField = {
  /** The key in the model's JSON. Immutable once it exists — payloads are stored under it. */
  key: string;
  /** What the client calls it, everywhere it is shown. */
  label: string;
  /** What the model is told to put there. This is what makes adding a field DO something. */
  description: string;
  /**
   * A field the code itself reads. Its label and description can change; it cannot be
   * removed, because something downstream would silently stop working.
   */
  lockedBecause?: string;
  /** Builtin-only: the model may not leave it empty. Never settable from the editor. */
  nonEmpty?: boolean;
};

export const EXTRACTION_TEMPLATE_SCHEMA = 'legal-assistant/extraction-template@1';

/** Keys the spine owns. A content field may never collide with one. */
export const RESERVED_FIELD_KEYS = new Set([
  'statement_type',
  'relationship_type',
  'current_page',
  'requires_legal_decision',
  'source_document_id',
  'source_version',
  'source_page',
  'source_excerpt',
  'evidence_quality',
  'ai_suggestion',
]);

const SUMMARY_FIELDS: ExtractionField[] = [
  {
    key: 'topic',
    label: 'Tema',
    description: 'Tema — the subject this statement belongs to; empty if not stated',
    lockedBecause: 'É o título de cada item na revisão e nos dados exportados.',
  },
  {
    key: 'scope',
    label: 'Âmbito de aplicação',
    description: 'Âmbito de aplicação — where/to what it applies; empty if not stated',
  },
  {
    key: 'content',
    label: 'Afirmação',
    description: 'The statement itself, pt-PT',
    lockedBecause: 'É a afirmação em si, e onde fica a frase de “não confirmado”.',
    nonEmpty: true,
  },
  { key: 'entity', label: 'Entidades abrangidas', description: 'Who the statement applies to; empty if not stated' },
  { key: 'required_action', label: 'Medidas a implementar', description: 'What must be done; empty if none' },
  { key: 'suggested_owner', label: 'Responsável sugerido', description: 'Who should own the action; empty if not stated' },
  {
    key: 'deadline',
    label: 'Data ou prazo',
    description: 'Deadline as written in the document; empty if none',
    lockedBecause: 'O validador §11 usa-o para exigir fonte a qualquer prazo.',
  },
  { key: 'consequence', label: 'Consequência', description: 'Consequence of non-compliance; empty if not stated' },
  { key: 'exceptions', label: 'Exceções', description: 'Stated exceptions; empty if none' },
];

const REVISION_FIELDS: ExtractionField[] = [
  {
    key: 'topic',
    label: 'Tema',
    description: 'The point of comparison this line is about',
    lockedBecause: 'É o título de cada linha na revisão e nos dados exportados.',
    nonEmpty: true,
  },
  {
    key: 'current_content',
    label: 'Documento atual',
    description: 'What the MAIN document currently states on this topic; empty if it is silent',
    lockedBecause: 'É o lado “documento atual” da matriz comparativa.',
  },
  {
    key: 'related_content',
    label: 'Documento relacionado',
    description: 'What the related document states',
    lockedBecause: 'É o lado “documento relacionado” da matriz comparativa.',
    nonEmpty: true,
  },
  {
    key: 'difference',
    label: 'Diferença',
    description: 'The difference between the two, stated plainly',
    lockedBecause: 'É a diferença que a matriz existe para mostrar.',
    nonEmpty: true,
  },
  {
    key: 'proposed_change',
    label: 'Alteração proposta',
    description: 'The concrete change proposed for the main document; empty if none',
  },
  { key: 'impact', label: 'Impacto', description: 'Impact of applying (or not applying) the change' },
];

export const BUILTIN_EXTRACTION_FIELDS: Record<AnalysisType, ExtractionField[]> = {
  summary: SUMMARY_FIELDS,
  revision: REVISION_FIELDS,
};

export const EXTRACTION_TEMPLATE_IDS: Record<AnalysisType, string> = {
  summary: 'dados_resumo',
  revision: 'dados_revisao',
};

export function analysisTypeOfExtractionTemplate(templateId: string): AnalysisType | null {
  if (templateId === 'dados_resumo') return 'summary';
  if (templateId === 'dados_revisao') return 'revision';
  return null;
}

function fieldsSetting(type: AnalysisType): string {
  return `templates.extraction.${type}`;
}

/** The fields in force now — the client's, if they changed them; the app's otherwise. */
export function extractionFields(type: AnalysisType): ExtractionField[] {
  const edited = getSetting(fieldsSetting(type));
  if (edited) {
    try {
      return JSON.parse(edited) as ExtractionField[];
    } catch {
      // A corrupt setting must not stop an analysis from running.
    }
  }
  return BUILTIN_EXTRACTION_FIELDS[type];
}

export function isExtractionEdited(type: AnalysisType): boolean {
  return Boolean(getSetting(fieldsSetting(type)));
}

const KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

/**
 * Validate a proposed field list. The rules exist because each one, broken, breaks something
 * downstream silently: a colliding key would overwrite a citation, a removed locked field
 * would disable a validator, and a renamed key would orphan every payload already stored.
 */
export function validateFields(type: AnalysisType, fields: ExtractionField[]): ExtractionField[] {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new ApiError('Um template de dados tem de ter pelo menos um campo.', 400);
  }
  if (fields.length > 40) throw new ApiError('Demasiados campos (máximo 40).', 400);

  const builtin = BUILTIN_EXTRACTION_FIELDS[type];
  const seen = new Set<string>();
  const cleaned: ExtractionField[] = [];
  for (const field of fields) {
    const key = String(field?.key || '').trim();
    if (!KEY_PATTERN.test(key)) {
      throw new ApiError(
        `“${key || '(vazio)'}” não é um nome de campo válido: use minúsculas, dígitos e underscore, começando por uma letra.`,
        400,
      );
    }
    if (RESERVED_FIELD_KEYS.has(key)) {
      throw new ApiError(`O campo “${key}” pertence à citação e não pode ser redefinido.`, 400);
    }
    if (seen.has(key)) throw new ApiError(`O campo “${key}” aparece duas vezes.`, 400);
    seen.add(key);
    const label = String(field?.label || '').trim();
    const description = String(field?.description || '').trim();
    if (!label) throw new ApiError(`O campo “${key}” precisa de um nome visível.`, 400);
    if (!description) {
      throw new ApiError(`O campo “${label}” precisa de uma descrição — é ela que diz ao agente o que procurar.`, 400);
    }
    const original = builtin.find((f) => f.key === key);
    cleaned.push({
      key,
      label: label.slice(0, 80),
      description: description.slice(0, 600),
      // Locking and emptiness are the app's, never the editor's, whatever was posted.
      ...(original?.lockedBecause ? { lockedBecause: original.lockedBecause } : {}),
      ...(original?.nonEmpty ? { nonEmpty: true } : {}),
    });
  }

  const missing = builtin.filter((f) => f.lockedBecause && !seen.has(f.key));
  if (missing.length) {
    throw new ApiError(
      `Não é possível remover ${missing.map((f) => `“${f.label}”`).join(', ')}: ${missing[0].lockedBecause}`,
      400,
    );
  }
  return cleaned;
}

export function saveExtractionFields(type: AnalysisType, fields: ExtractionField[]): ExtractionField[] {
  const cleaned = validateFields(type, fields);
  setSetting(fieldsSetting(type), JSON.stringify(cleaned));
  return cleaned;
}

export function revertExtractionFields(type: AnalysisType): void {
  setSetting(fieldsSetting(type), '');
}

/** The `.json` published to the library: the template as the document it describes. */
export function buildExtractionTemplateJson(type: AnalysisType): Buffer {
  return buildExtractionTemplateJsonFrom(type, extractionFields(type));
}

/** The same bytes, from a field list that has not been saved. */
export function buildExtractionTemplateJsonFrom(type: AnalysisType, fields: ExtractionField[]): Buffer {
  const body = {
    schema: EXTRACTION_TEMPLATE_SCHEMA,
    analysisType: type,
    fields: fields.map((field) => ({
      key: field.key,
      label: field.label,
      description: field.description,
      ...(field.lockedBecause ? { locked: true, lockedBecause: field.lockedBecause } : {}),
    })),
    grounding: {
      note: 'Every field above is subject to §10: the agent may only fill it from a document, page and verbatim excerpt. Unsupported content is marked not_confirmed.',
      fixedFields: [...RESERVED_FIELD_KEYS],
    },
  };
  return Buffer.from(`${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

export function extractionTemplateSha(type: AnalysisType): string {
  return createHash('sha256').update(buildExtractionTemplateJson(type)).digest('hex');
}
