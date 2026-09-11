import { ANALYSIS_STATE_LABELS } from '@/lib/types';
import type { MessageId, MessageParams } from '@/lib/workflow/messages';
import type { WorkflowFacts } from '@/lib/workflow/facts';
import type { PhaseKey } from '@/lib/workflow/phases';

// Every action a user can take on an analysis, with the conditions that must hold first.
//
// A precondition is written ONCE and used twice: the API throws its message when the
// action is called illegally, and the UI shows the same message as the reason the button
// is disabled. There is no second copy to fall out of step — which is how the same rule
// ended up implemented as SQL in approveAnalysis and as a JS filter in generateVersion,
// answering "before approval" in one place and "before drafting" in the other.

export const ACTION_IDS = [
  'identify_relations',
  'decide_document',
  'run',
  'decide_item',
  'approve_extraction',
  'generate_version',
  'upload_version',
  'edit_version',
  'set_final',
  'retry_conversion',
  'approve_pdf',
  'chat_send',
  'chat_decide',
  'approve_email',
  'track_back',
  'fork',
  'switch_path',
  'delete',
] as const;
export type ActionId = (typeof ACTION_IDS)[number];

export type Precondition = {
  id: string;
  /** true = satisfied. */
  test: (f: WorkflowFacts) => boolean;
  messageId: MessageId;
  params?: (f: WorkflowFacts) => MessageParams;
  status: 400 | 409;
};

export type ActionDef = {
  id: ActionId;
  phase: PhaseKey;
  labelId: MessageId | ((f: WorkflowFacts) => MessageId);
  busyLabelId?: MessageId;
  kind: 'primary' | 'secondary' | 'danger';
  method: 'POST' | 'PATCH' | 'DELETE';
  /** Built by the server, which knows the ids; `:id` placeholders are filled by the caller. */
  path: (analysisId: string) => string;
  /** ORDERED: the first unmet precondition is the reason shown and the error thrown. */
  preconditions: Precondition[];
  /** Whether the action needs AI, and what happens without it. */
  ai?: 'required' | 'degrades';
  /** Shown before the action when it destroys work. */
  confirmId?: (f: WorkflowFacts) => MessageId | null;
  /**
   * The response is a FILE, not JSON. Without this the generic handler parses the .eml as
   * JSON, throws, and the user never gets the download it just approved.
   */
  download?: boolean;
};

// --- shared preconditions ---------------------------------------------------------------
// Named, reused, and therefore identical everywhere they appear.

const stateIn = (...states: WorkflowFacts['state'][]): Precondition => ({
  id: `state_in:${states.join('|')}`,
  test: (f) => states.includes(f.state),
  messageId: 'block.state',
  // The user's own vocabulary — the raw state name is an implementation detail that was
  // leaking into the sentence under the chat composer.
  params: (f) => ({ state: ANALYSIS_STATE_LABELS[f.state] }),
  status: 409,
});

const notClosed: Precondition = {
  id: 'not_closed',
  test: (f) => !f.closed,
  messageId: 'block.closed',
  status: 409,
};

const onActivePath: Precondition = {
  id: 'on_active_path',
  test: (f) => f.isActivePath,
  messageId: 'block.not_active_path',
  params: (f) => ({ path: f.path.toUpperCase(), activePath: f.activePath.toUpperCase() }),
  status: 409,
};

const notBusy: Precondition = {
  id: 'not_busy',
  test: (f) => f.busyAction === '' || f.interrupted,
  messageId: 'block.busy',
  status: 409,
};

const aiRequiredRun: Precondition = {
  id: 'ai_configured',
  test: (f) => f.aiConfigured,
  messageId: 'block.ai_required.run',
  status: 400,
};

const aiRequiredChat: Precondition = {
  id: 'ai_configured',
  test: (f) => f.aiConfigured,
  messageId: 'block.ai_required.chat',
  status: 400,
};

const documentsDecided: Precondition = {
  id: 'documents_decided',
  test: (f) => f.type === 'summary' || f.relatedPending === 0,
  messageId: 'block.documents_pending',
  params: (f) => ({ n: f.relatedPending }),
  status: 409,
};

const hasConfirmedRelated: Precondition = {
  id: 'has_confirmed_related',
  test: (f) => f.type === 'summary' || f.relatedConfirmed > 0,
  messageId: 'block.no_confirmed_related',
  status: 409,
};

const hasExtraction: Precondition = {
  id: 'has_extraction',
  test: (f) => f.hasExtraction,
  messageId: 'block.extraction_missing',
  status: 409,
};

const hasItems: Precondition = {
  id: 'has_items',
  test: (f) => f.itemsAccepted > 0,
  messageId: 'block.no_items',
  status: 409,
};

/**
 * The single definition of the legal-decision rule. A user REJECTION is a decision — only
 * `pending` blocks — and both approving and drafting ask this same question now.
 */
const legalDecisionsSettled: Precondition = {
  id: 'legal_decisions_settled',
  test: (f) => f.legalDecisionsPending === 0,
  messageId: 'block.legal_decisions',
  params: (f) => ({ n: f.legalDecisionsPending }),
  status: 409,
};

const extractionApproved: Precondition = {
  id: 'extraction_approved',
  test: (f) => f.extractionApproved,
  messageId: 'block.extraction_not_approved',
  status: 409,
};

const hasVersion: Precondition = {
  id: 'has_version',
  test: (f) => f.versionCount > 0,
  messageId: 'block.no_version',
  status: 409,
};

const hasSectionedVersion: Precondition = {
  id: 'has_sectioned_version',
  test: (f) => f.hasSectionedVersion,
  messageId: 'block.no_version',
  status: 409,
};

const hasFinalVersion: Precondition = {
  id: 'has_final_version',
  test: (f) => f.finalVersionId !== '',
  messageId: 'block.no_final_version',
  status: 409,
};

const noPendingChange: Precondition = {
  id: 'no_pending_change',
  test: (f) => f.pendingTurnId === '',
  messageId: 'block.pending_change',
  status: 409,
};

const conversionReady: Precondition = {
  id: 'conversion_ready',
  test: (f) => f.conversionState === 'pronto_para_revisao',
  messageId: 'block.conversion_running',
  status: 409,
};

const conversionFailed: Precondition = {
  id: 'conversion_failed',
  test: (f) => f.conversionState === 'erro',
  messageId: 'block.conversion_running',
  status: 409,
};

// The §17 chain, in the order the user meets it: a PDF must exist, match the final DOCX by
// hash, be current, and be approved — before any draft can be built.
const pdfMatchesFinal: Precondition = {
  id: 'pdf_matches_final',
  test: (f) => f.conversionMatchesFinal,
  messageId: 'block.pdf_hash_mismatch',
  status: 409,
};

const pdfCurrent: Precondition = {
  id: 'pdf_current',
  test: (f) => f.conversionState !== 'desatualizado',
  messageId: 'block.pdf_stale',
  status: 409,
};

const pdfIsApproved: Precondition = {
  id: 'pdf_approved',
  test: (f) => f.pdfApproved,
  messageId: 'block.pdf_not_approved',
  status: 409,
};

// --- the actions --------------------------------------------------------------------------

export const ACTIONS: Record<ActionId, ActionDef> = {
  identify_relations: {
    id: 'identify_relations',
    phase: 'configuracao',
    labelId: 'action.identify_relations.label',
    busyLabelId: 'action.identify_relations.busy',
    kind: 'primary',
    method: 'POST',
    path: (id) => `/api/analyses/${id}/identify-relations`,
    ai: 'degrades',
    preconditions: [notClosed, onActivePath, stateIn('rascunho', 'a_identificar_relacoes', 'erro'), notBusy],
  },

  decide_document: {
    id: 'decide_document',
    phase: 'configuracao',
    labelId: 'action.identify_relations.label',
    kind: 'secondary',
    method: 'PATCH',
    path: (id) => `/api/analyses/${id}/documents/:documentId`,
    preconditions: [notClosed, onActivePath, stateIn('a_aguardar_confirmacao_de_documentos')],
  },

  run: {
    id: 'run',
    phase: 'extracao',
    labelId: (f) => (f.type === 'revision' ? 'action.run.label.revision' : 'action.run.label'),
    busyLabelId: 'action.run.busy',
    kind: 'primary',
    method: 'POST',
    path: (id) => `/api/analyses/${id}/run`,
    ai: 'required',
    preconditions: [
      notClosed,
      onActivePath,
      stateIn('rascunho', 'a_aguardar_confirmacao_de_documentos', 'erro'),
      notBusy,
      documentsDecided,
      hasConfirmedRelated,
      aiRequiredRun,
    ],
    // A re-run replaces the extraction, so the decisions taken on it go too.
    confirmId: (f) => (f.itemsAccepted > 0 ? 'trackback.consequence.loses_items' : null),
  },

  decide_item: {
    id: 'decide_item',
    phase: 'revisao',
    labelId: 'action.approve_extraction.label',
    kind: 'secondary',
    method: 'PATCH',
    path: (id) => `/api/analyses/${id}/items/:itemId`,
    preconditions: [notClosed, onActivePath, stateIn('pronta_para_revisao'), hasExtraction],
  },

  approve_extraction: {
    id: 'approve_extraction',
    phase: 'revisao',
    labelId: 'action.approve_extraction.label',
    busyLabelId: 'action.approve_extraction.busy',
    kind: 'primary',
    method: 'POST',
    path: (id) => `/api/analyses/${id}/approve`,
    preconditions: [
      notClosed,
      onActivePath,
      stateIn('pronta_para_revisao'),
      notBusy,
      hasExtraction,
      legalDecisionsSettled,
    ],
  },

  generate_version: {
    id: 'generate_version',
    phase: 'documento',
    labelId: (f) => (f.versionCount > 0 ? 'action.generate_version.again' : 'action.generate_version.label'),
    busyLabelId: 'action.generate_version.busy',
    kind: 'primary',
    method: 'POST',
    path: (id) => `/api/analyses/${id}/versions`,
    ai: 'degrades',
    preconditions: [
      notClosed,
      onActivePath,
      stateIn('pronta_para_revisao', 'alteracao_pendente_de_confirmacao', 'aprovada'),
      notBusy,
      hasItems,
      legalDecisionsSettled,
    ],
  },

  upload_version: {
    id: 'upload_version',
    phase: 'documento',
    labelId: 'action.generate_version.label',
    kind: 'secondary',
    method: 'POST',
    path: (id) => `/api/analyses/${id}/versions/manual`,
    preconditions: [
      notClosed,
      onActivePath,
      stateIn('pronta_para_revisao', 'alteracao_pendente_de_confirmacao', 'aprovada'),
    ],
  },

  edit_version: {
    id: 'edit_version',
    phase: 'documento',
    labelId: 'action.generate_version.label',
    kind: 'secondary',
    method: 'POST',
    path: (id) => `/api/analyses/${id}/versions/:versionId/edit`,
    preconditions: [
      notClosed,
      onActivePath,
      stateIn('pronta_para_revisao', 'alteracao_pendente_de_confirmacao', 'aprovada'),
      hasSectionedVersion,
    ],
  },

  set_final: {
    id: 'set_final',
    phase: 'documento',
    labelId: 'action.set_final.label',
    busyLabelId: 'action.set_final.busy',
    kind: 'primary',
    method: 'POST',
    path: (id) => `/api/analyses/${id}/versions/:versionId/final`,
    preconditions: [
      notClosed,
      onActivePath,
      stateIn('pronta_para_revisao', 'alteracao_pendente_de_confirmacao', 'aprovada'),
      notBusy,
      hasVersion,
    ],
  },

  retry_conversion: {
    id: 'retry_conversion',
    phase: 'pdf',
    labelId: 'action.retry_conversion.label',
    kind: 'secondary',
    method: 'POST',
    path: (id) => `/api/analyses/${id}/conversions/:conversionId/retry`,
    preconditions: [notClosed, onActivePath, hasFinalVersion, conversionFailed],
  },

  approve_pdf: {
    id: 'approve_pdf',
    phase: 'pdf',
    labelId: 'action.approve_pdf.label',
    busyLabelId: 'action.approve_pdf.busy',
    kind: 'primary',
    method: 'POST',
    path: (id) => `/api/analyses/${id}/conversions/:conversionId/approve`,
    preconditions: [notClosed, onActivePath, hasFinalVersion, pdfMatchesFinal, pdfCurrent, conversionReady],
  },

  chat_send: {
    id: 'chat_send',
    phase: 'documento',
    labelId: 'action.generate_version.label',
    kind: 'secondary',
    method: 'POST',
    path: (id) => `/api/analyses/${id}/chat`,
    ai: 'required',
    preconditions: [
      notClosed,
      onActivePath,
      noPendingChange,
      stateIn('pronta_para_revisao', 'aprovada'),
      hasSectionedVersion,
      aiRequiredChat,
    ],
  },

  chat_decide: {
    id: 'chat_decide',
    phase: 'documento',
    labelId: 'action.approve_extraction.label',
    kind: 'primary',
    method: 'PATCH',
    path: (id) => `/api/analyses/${id}/chat/:turnId`,
    preconditions: [notClosed, onActivePath, stateIn('alteracao_pendente_de_confirmacao')],
  },

  approve_email: {
    id: 'approve_email',
    phase: 'email',
    labelId: 'action.approve_email.label',
    kind: 'primary',
    method: 'POST',
    path: (id) => `/api/analyses/${id}/email-draft`,
    preconditions: [
      notClosed,
      onActivePath,
      hasFinalVersion,
      pdfMatchesFinal,
      pdfCurrent,
      pdfIsApproved,
    ],
  },

  // Reverting is legal from anywhere, including a closed analysis — it is how a closed
  // analysis is reopened.
  track_back: {
    id: 'track_back',
    phase: 'configuracao',
    labelId: 'action.track_back.label',
    kind: 'secondary',
    method: 'POST',
    path: (id) => `/api/analyses/${id}/track-back`,
    preconditions: [],
  },

  fork: {
    id: 'fork',
    phase: 'documento',
    labelId: 'action.track_back.label',
    kind: 'secondary',
    method: 'POST',
    path: (id) => `/api/analyses/${id}/versions/:versionId/fork`,
    preconditions: [],
  },

  switch_path: {
    id: 'switch_path',
    phase: 'configuracao',
    labelId: 'action.track_back.label',
    kind: 'secondary',
    method: 'POST',
    path: (id) => `/api/analyses/${id}/paths/:letter/activate`,
    preconditions: [],
  },

  delete: {
    id: 'delete',
    phase: 'configuracao',
    labelId: 'action.track_back.label',
    kind: 'danger',
    method: 'DELETE',
    path: (id) => `/api/analyses/${id}`,
    preconditions: [],
  },
};

/** The first unmet precondition of an action, or null when it is allowed. */
export function firstBlocker(action: ActionId, facts: WorkflowFacts): Precondition | null {
  for (const precondition of ACTIONS[action].preconditions) {
    if (!precondition.test(facts)) return precondition;
  }
  return null;
}

export function isActionId(value: string): value is ActionId {
  return (ACTION_IDS as readonly string[]).includes(value);
}
