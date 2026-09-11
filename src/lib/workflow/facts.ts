import type { AnalysisState, AnalysisType } from '@/lib/types';
import type { PhaseKey } from '@/lib/workflow/phases';

// The entire input to the workflow evaluator. Everything the rules are allowed to know
// about an analysis is in here — which is what makes the evaluator pure, testable without
// a database, and impossible to "help" with an extra lookup that the client cannot see.
//
// Facts are computed for ONE PATH. Two paths of the same analysis produce two different
// fact sets and therefore two different phases, which is exactly what the progress bar and
// the chat need in order to stop showing another path's work.

export type ConversionStatus =
  | 'none'
  | 'pendente'
  | 'em_conversao'
  | 'pronto_para_revisao'
  | 'aprovado_para_envio'
  | 'erro'
  | 'desatualizado';

export type WorkflowFacts = {
  analysisId: string;
  type: AnalysisType;
  state: AnalysisState;

  /** The path these facts describe, and the one the analysis is actually working on. */
  path: string;
  activePath: string;
  isActivePath: boolean;

  // configuração
  relatedTotal: number;
  relatedPending: number;
  relatedConfirmed: number;

  // extração / revisão
  itemsAccepted: number;
  itemsRejected: number;
  /** Matrix lines flagged requires_legal_decision that nobody has decided yet. */
  legalDecisionsPending: number;
  /** An extraction exists on this path (today: any stored item). */
  hasExtraction: boolean;
  /** Its result has been approved as a whole. */
  extractionApproved: boolean;

  // documento
  versionCount: number;
  hasSectionedVersion: boolean;
  /** The newest version on this path — what "approve the document" acts on. */
  latestVersionId: string;
  finalVersionId: string;

  // pdf
  conversionState: ConversionStatus;
  conversionId: string;
  conversionMatchesFinal: boolean;
  pdfApproved: boolean;

  // e-mail
  emailDraftCreated: boolean;
  emailApproved: boolean;

  // cross-cutting
  pendingTurnId: string;
  potentiallyAffected: boolean;
  affectedReason: string;
  aiConfigured: boolean;
  closed: boolean;

  /** An operation is running; `interrupted` = it was started before this process booted. */
  busyAction: string;
  busySince: number;
  interrupted: boolean;

  /** The last failure, if the analysis is in `erro`. */
  failedPhase: PhaseKey | null;
  failedDetail: string;

  now: number;
};

/** A fact set with everything empty — the base for tests and for a fresh analysis. */
export function emptyFacts(overrides: Partial<WorkflowFacts> = {}): WorkflowFacts {
  return {
    analysisId: '',
    type: 'summary',
    state: 'rascunho',
    path: 'a',
    activePath: 'a',
    isActivePath: true,
    relatedTotal: 0,
    relatedPending: 0,
    relatedConfirmed: 0,
    itemsAccepted: 0,
    itemsRejected: 0,
    legalDecisionsPending: 0,
    hasExtraction: false,
    extractionApproved: false,
    versionCount: 0,
    hasSectionedVersion: false,
    latestVersionId: '',
    finalVersionId: '',
    conversionState: 'none',
    conversionId: '',
    conversionMatchesFinal: false,
    pdfApproved: false,
    emailDraftCreated: false,
    emailApproved: false,
    pendingTurnId: '',
    potentiallyAffected: false,
    affectedReason: '',
    aiConfigured: false,
    closed: false,
    busyAction: '',
    busySince: 0,
    interrupted: false,
    failedPhase: null,
    failedDetail: '',
    now: 0,
    ...overrides,
  };
}
