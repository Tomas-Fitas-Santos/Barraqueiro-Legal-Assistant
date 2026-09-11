import type { ExtractionField } from '@/lib/server/repo/extraction-template';
import type { JsonSchema } from '@/lib/server/ai/validate';
import { DOC_TYPES } from '@/lib/types';

// JSON Schemas for the AI stages. Structured data before prose: a stage's model call is
// forced onto one of these via the output tool, then re-validated app-side (schema here,
// citations against the page-anchored segment store from phase 2 on).

// A citation as every factual statement must carry it. `page` is validated against the
// app's own page store; `excerpt` must appear on that page (both checked in phase 4's
// citation validators — this schema is the shape contract only).
export const CITATION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['document_id', 'page', 'excerpt'],
  properties: {
    document_id: { type: 'string', minLength: 1, description: 'App-assigned id of the source document' },
    page: { type: 'integer', description: '1-based page number in the source document' },
    excerpt: { type: 'string', minLength: 1, description: 'Short verbatim excerpt from that page' },
  },
};

// Stage: classify a newly ingested document + extract its metadata (phase 2 uses this).
// NOTE: OpenAI strict mode requires EVERY property to appear in `required` — optionality
// is expressed as an empty string/array, never by omission. Keep all stage schemas that
// way or the API rejects the tool definition outright.
export const CLASSIFICATION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'document_type', 'title', 'subject', 'issued_date', 'effective_date', 'expiry_date', 'language',
    'entity', 'group_area', 'version_label', 'approval_status', 'topics', 'subtopics',
    'legislation', 'obligations', 'deadlines', 'references', 'semantic_profile',
  ],
  properties: {
    // §7.9's understanding step, folded into a call that already happens once per content
    // hash — the semantic index costs ZERO extra AI calls. Embedding raw statutory text
    // retrieves badly; embedding this account of what the document is ABOUT is what lets
    // "despedimento" find a document that only ever says "cessação do contrato de trabalho".
    semantic_profile: {
      type: 'object',
      additionalProperties: false,
      required: ['concepts', 'synonyms', 'section_abstracts'],
      properties: {
        concepts: {
          type: 'array',
          items: { type: 'string' },
          description: 'The document\'s concepts in normalised pt-PT legal vocabulary, 5-15 entries',
        },
        synonyms: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Alternative formulations a Portuguese lawyer would use for those same concepts, including the everyday wording and the statutory wording',
        },
        section_abstracts: {
          type: 'array',
          items: { type: 'string' },
          description: 'One line per section of the document saying what that section is about, pt-PT',
        },
      },
    },
    expiry_date: { type: 'string', description: 'ISO date the document stops applying, if stated, else empty' },
    // The document's own state, not how far the app got reading it.
    approval_status: { enum: ['rascunho', 'aprovado', ''] },
    legislation: {
      type: 'array',
      items: { type: 'string' },
      description: 'Laws, decrees and regulations cited, as written in the document',
    },
    obligations: {
      type: 'array',
      items: { type: 'string' },
      description: 'Obligations the document imposes, one per entry, pt-PT',
    },
    deadlines: {
      type: 'array',
      items: { type: 'string' },
      description: 'Dates and deadlines the document sets, as written',
    },
    entity: { type: 'string', description: 'Issuing entity/company if stated, else empty' },
    group_area: { type: 'string', description: 'Area of the group the document belongs to if stated, else empty' },
    version_label: { type: 'string', description: 'Version marking as written in the document (e.g. "v03", "2.ª revisão"), else empty' },
    subtopics: { type: 'array', items: { type: 'string' }, description: 'Finer sub-topic keywords, pt-PT' },
    // Derived, not repeated: the vocabulary and its pt-PT labels live in @/lib/types, and a
    // value the label map does not cover would reach the user as a raw identifier.
    document_type: { enum: [...DOC_TYPES] },
    title: { type: 'string', minLength: 1 },
    subject: { type: 'string' },
    issued_date: { type: 'string', description: 'ISO date if stated in the document, else empty' },
    effective_date: { type: 'string', description: 'ISO date if stated in the document, else empty' },
    language: { type: 'string' },
    topics: { type: 'array', items: { type: 'string' }, description: 'Short topic keywords, pt-PT' },
    references: {
      type: 'array',
      description: 'Explicit references to other documents/laws found in the text',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'citation'],
        properties: {
          text: { type: 'string', minLength: 1 },
          citation: CITATION_SCHEMA,
        },
      },
    },
  },
};

// Stage: structured extraction for the Document Summary workflow — the briefing §10 field
// list verbatim, every property required (strict mode; absence = empty string / 0).
//
// The CONTENT fields come from the extraction template, which the client can change; the
// grounding spine below does not, because §11's validators rest on it. That split is the
// whole point: a template that could delete `source_excerpt` would be a template that could
// switch off citation checking.
function contentProperties(fields: ExtractionField[]): Record<string, JsonSchema> {
  const props: Record<string, JsonSchema> = {};
  for (const field of fields) {
    props[field.key] = { type: 'string', description: field.description, ...(field.nonEmpty ? { minLength: 1 } : {}) };
  }
  return props;
}

const STATEMENT_SPINE: Record<string, JsonSchema> = {
  statement_type: {
    enum: ['obligation', 'deadline', 'responsibility', 'sanction', 'reference', 'definition', 'recommendation', 'other'],
  },
  source_document_id: { type: 'string', description: 'App id of the source document; empty ONLY for not_confirmed or pure suggestions' },
  source_version: { type: 'string', description: 'Version label of the source document; empty if unknown' },
  source_page: { type: 'integer', description: '1-based page; 0 when there is no source' },
  source_excerpt: { type: 'string', description: 'Verbatim excerpt from that page; empty when there is no source' },
  evidence_quality: { enum: ['direct', 'indirect', 'ambiguous', 'not_confirmed'] },
  ai_suggestion: { type: 'boolean', description: 'true when this is YOUR suggestion, not a documented fact' },
};

const MATRIX_SPINE: Record<string, JsonSchema> = {
  relationship_type: {
    enum: [
      'nova_versao_de', 'versao_anterior_de', 'substitui', 'e_substituido_por', 'altera',
      'e_alterado_por', 'complementa', 'e_aplicavel_a', 'cita', 'e_citado_por',
      'potencialmente_contradiz', 'serve_de_evidencia_para', 'trata_o_mesmo_tema',
    ],
  },
  current_page: { type: 'integer', description: '1-based page in the MAIN document; 0 if it is silent' },
  requires_legal_decision: { type: 'boolean' },
  source_document_id: { type: 'string', description: 'App id of the RELATED document the line rests on' },
  source_version: { type: 'string' },
  source_page: { type: 'integer', description: '1-based page in the related document; 0 when unsupported' },
  source_excerpt: { type: 'string' },
  evidence_quality: { enum: ['direct', 'indirect', 'ambiguous', 'not_confirmed'] },
  ai_suggestion: { type: 'boolean' },
};

function itemSchema(fields: ExtractionField[], spine: Record<string, JsonSchema>): JsonSchema {
  const properties = { ...contentProperties(fields), ...spine };
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

export function summaryExtractionSchema(fields: ExtractionField[]): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['statements'],
    properties: { statements: { type: 'array', minItems: 1, items: itemSchema(fields, STATEMENT_SPINE) } },
  };
}

export function revisionMatrixSchema(fields: ExtractionField[]): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['lines'],
    properties: { lines: { type: 'array', minItems: 1, items: itemSchema(fields, MATRIX_SPINE) } },
  };
}

// Stage: OCR one rasterized page (phase 2). Mechanical transcription — no citations, no
// judgement; the page image is the entire input.
export const OCR_PAGE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['page_text'],
  properties: {
    page_text: {
      type: 'string',
      description:
        'All legible text on the page, transcribed exactly, in reading order, as Markdown: "# "/"## " for headings, "- " for bullet items, GFM pipe tables for tabular content, paragraphs separated by blank lines. Empty string if the page holds no text.',
    },
  },
};

// Stage: judge the relation type between a main document and each shortlisted candidate
// (phase 3). One call per proposal run; only shortlisted candidates are judged, and the
// app enforces the exact-reference rule on strong types AFTER this returns.
export const RELATION_JUDGEMENT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['relations'],
  properties: {
    relations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'to_document_id', 'type', 'rationale', 'relevance',
          'evidence_document_id', 'evidence_page', 'evidence_excerpt',
        ],
        properties: {
          to_document_id: { type: 'string', minLength: 1 },
          type: {
            enum: [
              'nova_versao_de', 'versao_anterior_de', 'substitui', 'e_substituido_por',
              'altera', 'e_alterado_por', 'complementa', 'e_aplicavel_a', 'cita',
              'e_citado_por', 'potencialmente_contradiz', 'serve_de_evidencia_para',
              'trata_o_mesmo_tema',
            ],
          },
          rationale: { type: 'string', minLength: 1, description: 'One sentence, pt-PT, grounded in the provided evidence' },
          // §5.3: what the user reads when deciding whether this document belongs in the
          // analysis. A band, never a number — a self-reported float would be false
          // precision sitting next to a categorical relation type.
          relevance: {
            enum: ['alta', 'media', 'baixa'],
            description:
              'How much this candidate would change the analysis of the main document: alta = it must be read, baixa = it merely touches the same area',
          },
          evidence_document_id: { type: 'string', description: 'Document holding the supporting excerpt; empty if none' },
          evidence_page: { type: 'integer', description: '1-based page of the excerpt; 0 if none' },
          evidence_excerpt: { type: 'string', description: 'Verbatim excerpt supporting the relation; empty if none' },
        },
      },
    },
  },
};

// Stage: the narrative document generated ONLY from validated items (phase 5). Bodies may
// reference the numbered reference list with [n] markers; the app strips unknown markers
// and renders the "Anexo de fontes" deterministically from the items' own citations.
export const NARRATIVE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sections'],
  properties: {
    sections: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['heading', 'body'],
        properties: {
          heading: { type: 'string', minLength: 1 },
          body: { type: 'string', minLength: 1, description: 'pt-PT prose; cite the numbered references as [n]' },
        },
      },
    },
  },
};

// Stage: one revision-chat turn (briefing §13). The model returns the FULL revised
// narrative plus its own impact assessment — which the app cross-checks deterministically
// and overrides whenever the app's verdict is stricter.
export const REVISION_TURN_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'reply', 'affected_sections', 'change_type', 'affected_sources',
    'removes_factual_content', 'alters_obligations_deadlines_references',
    'requires_confirmation', 'sections',
  ],
  properties: {
    reply: { type: 'string', minLength: 1, description: 'Short pt-PT explanation of what was changed and why' },
    affected_sections: { type: 'array', items: { type: 'string' } },
    change_type: { type: 'string', minLength: 1, description: 'e.g. simplificação, reescrita, remoção, tabela, tom' },
    affected_sources: { type: 'array', items: { type: 'string' }, description: 'Reference numbers ([n] values) whose citations this change touches' },
    removes_factual_content: { type: 'boolean' },
    alters_obligations_deadlines_references: { type: 'boolean' },
    requires_confirmation: { type: 'boolean' },
    sections: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['heading', 'body'],
        properties: {
          heading: { type: 'string', minLength: 1 },
          body: { type: 'string', minLength: 1 },
        },
      },
    },
  },
};
