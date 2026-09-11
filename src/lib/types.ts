// Shared, client-safe types and constants. Server-only types live in src/lib/server/.

// MVP is single-user, but the role vocabulary exists so adding people later is a data
// change, not a schema redesign. 'admin' is the only role until the client asks otherwise.
export const ROLES = ['admin'] as const;
export type Role = (typeof ROLES)[number];

export type SessionInfo = {
  userId: string;
  role: Role;
  name: string;
  email: string;
};

// The two workflows (briefing §2). Everything an analysis stores hangs off one of these.
export const ANALYSIS_TYPES = ['summary', 'revision'] as const;
export type AnalysisType = (typeof ANALYSIS_TYPES)[number];

export const ANALYSIS_TYPE_LABELS: Record<AnalysisType, string> = {
  summary: 'Resumo documental',
  revision: 'Revisão / Atualização',
};

// Model catalogue offered by the ChatGPT-subscription runtime (mirrors the agent host's
// DEFAULT_CODEX_MODELS — the subscription serves these). Selection lives in settings.
export const AI_MODELS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
] as const;
export type AiModel = (typeof AI_MODELS)[number];
export const DEFAULT_AI_MODEL: AiModel = 'gpt-5.6-sol';

export function isAiModel(value: unknown): value is AiModel {
  return AI_MODELS.includes(String(value || '') as AiModel);
}

// Document pipeline states (mirrors the CHECK constraint in db.ts). 'removed' is a flag on
// the row, not a state.
//
// This is the COARSE value, and it stays coarse: about eight server gates branch on it
// ('is this document indexed?', 'does it still need processing?'), and SQLite cannot ALTER a
// CHECK constraint. The client's finer vocabulary lives in `stage` beside it.
export const DOCUMENT_STATES = ['listed', 'downloaded', 'processing', 'indexed', 'failed'] as const;
export type DocumentState = (typeof DOCUMENT_STATES)[number];

/** What the pipeline is doing right now — the part of §6 the coarse state cannot express. */
export const DOCUMENT_STAGES = ['recebido', 'em_extracao', 'em_ocr', 'em_classificacao', 'indexado', 'erro'] as const;
export type DocumentStage = (typeof DOCUMENT_STAGES)[number];

/** The client's §6 vocabulary, and the only state vocabulary the UI is allowed to show. */
export const CLIENT_DOCUMENT_STATES = [
  'recebido',
  'em_extracao',
  'em_ocr',
  'em_classificacao',
  'indexado',
  'indexado_com_alerta',
  'erro',
  'em_falta',
  'eliminado',
] as const;
export type ClientDocumentState = (typeof CLIENT_DOCUMENT_STATES)[number];

export const CLIENT_DOCUMENT_STATE_LABELS: Record<ClientDocumentState, string> = {
  recebido: 'Recebido',
  em_extracao: 'Em extração',
  em_ocr: 'Em OCR',
  em_classificacao: 'Em classificação',
  indexado: 'Indexado',
  indexado_com_alerta: 'Indexado com alerta de OCR',
  erro: 'Erro',
  em_falta: 'Em falta',
  eliminado: 'Eliminado',
};

/**
 * The one place §6's state is decided. Pure, so the server computes it once and every screen
 * reads the answer instead of re-deriving it — four screens deriving "is this one indexed
 * with an OCR alert?" is four chances to disagree with each other.
 *
 * Two of the eight are deliberately NOT stored. The OCR alert needs a live count, because a
 * page finishing OCR must change the state without a re-ingest; and Eliminado must not
 * overwrite the row's last pipeline state, or restoring a document would forget what it was.
 */
export function clientDocumentState(row: {
  state: string;
  stage?: string;
  removed?: boolean | number;
  missing?: boolean | number;
  ocrPendingPages?: number;
}): ClientDocumentState {
  if (row.removed) return 'eliminado';
  // Ranked above every pipeline state: what the app knows ABOUT the document is still true,
  // but the file itself is not where the library is, so nothing can be done with it until it
  // comes back. Showing "Indexado" for a file that cannot be opened is the silent failure.
  if (row.missing) return 'em_falta';
  if (row.state === 'failed') return 'erro';
  if (row.state === 'indexed') return Number(row.ocrPendingPages || 0) > 0 ? 'indexado_com_alerta' : 'indexado';
  if (row.state === 'processing') {
    const stage = String(row.stage || '');
    return stage === 'em_ocr' || stage === 'em_classificacao' ? stage : 'em_extracao';
  }
  return 'recebido';
}

/**
 * The documental type the classifier assigns (briefing §8, "tipo documental").
 *
 * The STORED value stays these English identifiers: they are fed to two AI prompts and are
 * the enum of the classification schema, so translating the value would mean a data
 * migration, a schema change and a prompt change to gain nothing. What was actually wrong is
 * that the raw identifier was shown to the user — hence the label map below.
 */
export const DOC_TYPES = [
  'code_of_conduct',
  'plan',
  'policy',
  'internal_note',
  'regulation',
  'contract',
  'report',
  'other',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  code_of_conduct: 'Código de conduta',
  plan: 'Plano',
  policy: 'Política',
  internal_note: 'Nota interna',
  regulation: 'Regulamento',
  contract: 'Contrato',
  report: 'Relatório',
  other: 'Outro',
};

/** What a folder is, in the same column that shows a file's documental type. */
export const FOLDER_TYPE_LABEL = 'Pasta';

/**
 * Whether the document itself is a draft or an approved text (§8, "estado: rascunho ou
 * aprovado").
 *
 * A DIFFERENT AXIS from `documents.state`, which is how far the app has got reading the
 * file. §5.2 and §8 both call their field "estado" and they are not the same thing, so the
 * two are labelled apart everywhere: *Estado do documento* here, *Estado da indexação* there.
 */
export const APPROVAL_STATUSES = ['rascunho', 'aprovado'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  rascunho: 'Rascunho',
  aprovado: 'Aprovado',
};

export function approvalStatusLabel(value: string): string {
  const key = String(value || '');
  if (!key) return '—';
  return APPROVAL_STATUS_LABELS[key as ApprovalStatus] || key;
}

export const CONVERSION_STATES = [
  'pendente',
  'em_conversao',
  'pronto_para_revisao',
  'aprovado_para_envio',
  'erro',
  'desatualizado',
] as const;
export type ConversionState = (typeof CONVERSION_STATES)[number];

export const CONVERSION_STATE_LABELS: Record<ConversionState, string> = {
  pendente: 'Pendente',
  em_conversao: 'Em conversão',
  pronto_para_revisao: 'PDF pronto para revisão',
  aprovado_para_envio: 'PDF aprovado para envio',
  erro: 'Erro na conversão',
  desatualizado: 'PDF desatualizado',
};

/**
 * The same conversion states as seen from the LIBRARY, where the row is a file rather than a
 * step of an analysis.
 *
 * The labels above are written for the analysis screen and say "PDF" because that is what is
 * being converted there; in a folder listing they would sit on a .docx row and describe the
 * wrong file. What the folder wants to answer is the question the client actually asks of a
 * generated document — is this approved or not — so the wording drops the mechanism and
 * keeps the decision.
 */
export const GENERATED_STATE_LABELS: Record<ConversionState, string> = {
  pendente: 'Em preparação',
  em_conversao: 'Em preparação',
  pronto_para_revisao: 'Por aprovar',
  aprovado_para_envio: 'Aprovado',
  erro: 'Erro',
  desatualizado: 'Desatualizado',
};

/**
 * A template's state is whether the client has changed it. There is no processing state to
 * report — a template is never read as a document — but "has this been customised" is real,
 * is the question `Repor original` answers, and is otherwise invisible without opening each
 * one in turn.
 */
export const TEMPLATE_EDIT_LABELS = {
  edited: 'Editado',
  original: 'Original',
} as const;

/**
 * The documental type, in the user's language. An unrecognised value is shown as-is rather
 * than hidden: a hand-corrected `doc_type` that fell outside the vocabulary is information,
 * not an error to swallow.
 */
export function docTypeLabel(value: string): string {
  const key = String(value || '');
  if (!key) return '—';
  return DOC_TYPE_LABELS[key as DocType] || key;
}

/** How well the app could read a scanned document (written by the ingest pipeline). */
export const OCR_QUALITY_LABELS: Record<string, string> = {
  'n/a': 'Não aplicável',
  pendente: 'Por transcrever',
  boa: 'Boa',
  parcial: 'Parcial',
};

export function ocrQualityLabel(value: string): string {
  const key = String(value || '');
  if (!key) return '—';
  return OCR_QUALITY_LABELS[key] || key;
}

// The 13 documental relation types, verbatim from the briefing (§9). Directed: the type
// reads FROM → TO ("A altera B" = from:A, type:altera, to:B).
export const RELATION_TYPES = [
  'nova_versao_de',
  'versao_anterior_de',
  'substitui',
  'e_substituido_por',
  'altera',
  'e_alterado_por',
  'complementa',
  'e_aplicavel_a',
  'cita',
  'e_citado_por',
  'potencialmente_contradiz',
  'serve_de_evidencia_para',
  'trata_o_mesmo_tema',
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export const RELATION_TYPE_LABELS: Record<RelationType, string> = {
  nova_versao_de: 'nova versão de',
  versao_anterior_de: 'versão anterior de',
  substitui: 'substitui',
  e_substituido_por: 'é substituído por',
  altera: 'altera',
  e_alterado_por: 'é alterado por',
  complementa: 'complementa',
  e_aplicavel_a: 'é aplicável a',
  cita: 'cita',
  e_citado_por: 'é citado por',
  potencialmente_contradiz: 'potencialmente contradiz',
  serve_de_evidencia_para: 'serve de evidência para',
  trata_o_mesmo_tema: 'trata o mesmo tema',
};

/**
 * The same fact stated from the other end.
 *
 * These pairs are why one relation could be stored twice: the sweep finds «A cita B» from
 * A's side and «B é citado por A» from B's, and records two rows for one link. Used to
 * merge the motives of a pair, never to REWRITE one into the other — a type is flipped
 * only when someone has evidence for the flipped claim, and merging is not evidence.
 */
export const RELATION_TYPE_INVERSES: Partial<Record<RelationType, RelationType>> = {
  nova_versao_de: 'versao_anterior_de',
  versao_anterior_de: 'nova_versao_de',
  substitui: 'e_substituido_por',
  e_substituido_por: 'substitui',
  altera: 'e_alterado_por',
  e_alterado_por: 'altera',
  cita: 'e_citado_por',
  e_citado_por: 'cita',
  complementa: 'e_aplicavel_a',
  e_aplicavel_a: 'complementa',
  // `potencialmente_contradiz` and `trata_o_mesmo_tema` are their own inverse; a
  // `serve_de_evidencia_para` has no named opposite and stays a motive of its own.
  potencialmente_contradiz: 'potencialmente_contradiz',
  trata_o_mesmo_tema: 'trata_o_mesmo_tema',
};

export function inverseOf(type: RelationType): RelationType | '' {
  return RELATION_TYPE_INVERSES[type] || '';
}

/**
 * How a related document got onto an analysis. Not a RelationType: nobody judged a
 * relation, the user picked the document in the wizard — and the gate used to render this
 * identifier at them raw.
 */
export const WIZARD_PICK_RELATION = 'selecionado_no_assistente';

/** Where a relation stands, in the client's language. Tone/colour stays in the component. */
export const RELATION_STATUS_LABELS: Record<string, string> = {
  proposed: 'Proposta',
  confirmed: 'Confirmada',
  rejected: 'Rejeitada',
};

/** The label for whatever sits in `analysis_documents.relation_type`, including the above. */
export function relatedDocumentRelationLabel(value: string): string {
  if (value === WIZARD_PICK_RELATION) return 'escolhido por si';
  return RELATION_TYPE_LABELS[value as RelationType] || '';
}

/**
 * §5.3's relevância. An ENUM, not a number: this repo already made that call for
 * evidence_quality, a model's self-reported float is false precision, and a numeric axis
 * beside a categorical one invites the two to contradict each other in front of the user.
 */
export const RELEVANCE_BANDS = ['alta', 'media', 'baixa'] as const;
export type Relevance = (typeof RELEVANCE_BANDS)[number];

export const RELEVANCE_LABELS: Record<Relevance, string> = {
  alta: 'relevância alta',
  media: 'relevância média',
  baixa: 'relevância baixa',
};

export function isRelevance(value: string): value is Relevance {
  return (RELEVANCE_BANDS as readonly string[]).includes(value);
}

/**
 * Confiança on a relation — how sure the app is that the link is REAL, which is a different
 * question from relevância's "how much would it change the analysis". Both are shown, and
 * neither is allowed to stand in for the other: a document can be highly relevant and
 * something the app has no evidence for at all.
 *
 * The same four words the extraction uses, on purpose — one vocabulary for certainty.
 */
export const RELATION_CONFIDENCE_LABELS: Record<string, string> = {
  alta: 'Confiança alta',
  media: 'Confiança média',
  baixa: 'Confiança baixa',
  nao_confirmada: 'Não confirmada',
};

// The types that assert one document CHANGES another. Semantic similarity alone never
// concludes these (briefing §9) — the app enforces an exact-reference requirement.
export const STRONG_RELATION_TYPES: RelationType[] = [
  'substitui',
  'e_substituido_por',
  'altera',
  'e_alterado_por',
];

export function isRelationType(value: unknown): value is RelationType {
  return RELATION_TYPES.includes(String(value || '') as RelationType);
}

// Analysis states, verbatim from the briefing (§6). An approved analysis is only ever
// reopened by creating a new version (phase 5).
export const ANALYSIS_STATES = [
  'rascunho',
  'a_identificar_relacoes',
  'a_aguardar_confirmacao_de_documentos',
  'em_processamento',
  'pronta_para_revisao',
  'alteracao_pendente_de_confirmacao',
  'aprovada',
  'erro',
  'eliminada',
] as const;
export type AnalysisState = (typeof ANALYSIS_STATES)[number];

export const ANALYSIS_STATE_LABELS: Record<AnalysisState, string> = {
  rascunho: 'Rascunho',
  a_identificar_relacoes: 'A identificar relações',
  a_aguardar_confirmacao_de_documentos: 'A aguardar confirmação de documentos',
  em_processamento: 'Em processamento',
  pronta_para_revisao: 'Pronta para revisão',
  alteracao_pendente_de_confirmacao: 'Alteração pendente de confirmação',
  aprovada: 'Aprovada',
  erro: 'Erro',
  eliminada: 'Eliminada',
};

export const STATEMENT_TYPES = [
  'obligation',
  'deadline',
  'responsibility',
  'sanction',
  'reference',
  'definition',
  'recommendation',
  'other',
] as const;
export type StatementType = (typeof STATEMENT_TYPES)[number];

export const STATEMENT_TYPE_LABELS: Record<StatementType, string> = {
  obligation: 'obrigação',
  deadline: 'prazo',
  responsibility: 'responsabilidade',
  sanction: 'sanção',
  reference: 'referência',
  definition: 'definição',
  recommendation: 'recomendação',
  other: 'outro',
};
