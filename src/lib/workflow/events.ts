import type { AnalysisType } from '@/lib/types';
import { failureCause, failureRemedy } from '@/lib/workflow/failure-text';
import { msg, type MessageId } from '@/lib/workflow/messages';
import { phaseLabel, type PhaseKey } from '@/lib/workflow/phases';

// One table for everything that can happen to an analysis.
//
// It replaces four separate tables that each knew a piece and disagreed at the edges: the
// client's STAGE_OF_EVENT (which listed three events the server suppresses and omitted
// four it records), the server's MATERIALISED set, the client's eventSentence() switch,
// and the milestone map inside buildGraph. Anything missing from here is now a type error
// rather than an event that silently appears in neither the chat nor the history.

export const EVENT_KINDS = [
  'created',
  'relations_identified',
  'document_confirmed',
  'document_excluded',
  'run_started',
  'run_refused',
  'run_completed',
  'item_rejected',
  'item_decided',
  'items_discarded',
  'extraction_approved',
  'extraction_rejected',
  'extraction_edited',
  'approved',
  'narrative_markers_stripped',
  'version_generated',
  'version_uploaded_manual',
  'version_edited_in_app',
  'version_set_final',
  'pdf_converted',
  'pdf_conversion_failed',
  'pdf_approved',
  'email_draft_created',
  'email_draft_edited',
  'email_approved',
  'analysis_closed',
  'analysis_reopened',
  'chat_change_pending',
  'chat_change_applied',
  'chat_change_confirmed',
  'chat_change_discarded',
  'tracked_back',
  'path_forked',
  'path_switched',
  'potentially_affected',
  'affected_dismissed',
  'ai_degraded',
  'error',
  'deleted',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export type EventDef = {
  /** 'derived' = the event's own payload names its phase (tracked_back, error). */
  phase: PhaseKey | 'derived';
  /** The agent's sentence in the chat. null = the history graph only. */
  chat: MessageId | null;
  /**
   * Who is speaking. An approval is something the USER did, and reading "Fixei esta versão
   * como final" when you pressed the button yourself makes the agent sound like it decided.
   */
  voice?: 'agent' | 'user';
  /** Its own node in the history graph, rather than folded into the phase's node. */
  milestone: boolean;
  /** The short label on that node's card. */
  node?: MessageId;
  severity: 'info' | 'success' | 'warning' | 'error';
  /** Rendered as a version / conversion / turn card instead of an event bubble. */
  materialised?: boolean;
};

export const EVENTS: Record<EventKind, EventDef> = {
  // --- configuração ---------------------------------------------------------------------
  created: { phase: 'configuracao', chat: 'event.created', milestone: true, severity: 'info', node: 'node.created' },
  relations_identified: {
    phase: 'configuracao',
    chat: 'event.relations_identified',
    milestone: true,
    severity: 'info',
    node: 'node.relations_identified',
  },
  // Confirming documents one by one would flood the chat; the count is in the phase card.
  document_confirmed: { phase: 'configuracao', chat: null, milestone: false, severity: 'info' },
  document_excluded: { phase: 'configuracao', chat: null, milestone: false, severity: 'info' },

  // --- extração -------------------------------------------------------------------------
  run_started: { phase: 'extracao', chat: null, milestone: false, severity: 'info' },
  run_refused: { phase: 'extracao', chat: 'event.run_refused', milestone: true, severity: 'error', node: 'node.run_refused' },
  run_completed: { phase: 'extracao', chat: 'event.run_completed', milestone: true, severity: 'success', node: 'node.run_completed' },
  // Per-item rejections ride along inside the extraction node, where their reasons are read.
  item_rejected: { phase: 'extracao', chat: null, milestone: false, severity: 'warning' },
  items_discarded: { phase: 'extracao', chat: 'event.items_discarded', milestone: false, severity: 'warning' },

  // --- revisão --------------------------------------------------------------------------
  item_decided: { phase: 'revisao', chat: null, milestone: false, severity: 'info' },
  extraction_rejected: {
    phase: 'revisao',
    chat: 'event.extraction_rejected',
    voice: 'user',
    milestone: true,
    severity: 'warning',
    node: 'node.extraction_rejected',
  },
  extraction_approved: {
    phase: 'revisao',
    chat: 'event.extraction_approved',
    voice: 'user',
    milestone: true,
    severity: 'success',
    node: 'node.extraction_approved',
  },
  extraction_edited: {
    phase: 'revisao',
    chat: 'event.extraction_edited',
    voice: 'user',
    milestone: false,
    severity: 'info',
  },
  approved: { phase: 'revisao', chat: 'event.approved', milestone: true, severity: 'success', node: 'node.approved' },
  chat_change_pending: { phase: 'revisao', chat: null, milestone: false, severity: 'warning', materialised: true },
  chat_change_applied: { phase: 'revisao', chat: null, milestone: false, severity: 'info', materialised: true },
  chat_change_confirmed: { phase: 'revisao', chat: null, milestone: false, severity: 'info', materialised: true },
  chat_change_discarded: { phase: 'revisao', chat: null, milestone: false, severity: 'info', materialised: true },

  // --- documento ------------------------------------------------------------------------
  narrative_markers_stripped: {
    phase: 'documento',
    chat: 'event.narrative_markers_stripped',
    milestone: false,
    severity: 'warning',
  },
  version_generated: { phase: 'documento', chat: null, milestone: false, severity: 'success', materialised: true },
  version_uploaded_manual: { phase: 'documento', chat: null, milestone: false, severity: 'info', materialised: true },
  version_edited_in_app: {
    phase: 'documento',
    chat: 'event.version_edited_in_app',
    voice: 'user',
    milestone: false,
    severity: 'info',
  },

  // --- pdf ------------------------------------------------------------------------------
  version_set_final: {
    phase: 'documento',
    chat: 'event.version_set_final',
    voice: 'user',
    milestone: true,
    severity: 'success',
    node: 'node.version_set_final',
  },
  pdf_converted: { phase: 'pdf', chat: null, milestone: false, severity: 'success', materialised: true },
  pdf_conversion_failed: {
    phase: 'pdf',
    chat: 'event.pdf_conversion_failed',
    milestone: true,
    severity: 'error',
    node: 'node.pdf_conversion_failed',
  },
  pdf_approved: {
    phase: 'pdf',
    chat: 'event.pdf_approved',
    voice: 'user',
    milestone: true,
    severity: 'success',
    node: 'node.pdf_approved',
  },

  // --- e-mail ---------------------------------------------------------------------------
  email_draft_created: {
    phase: 'email',
    chat: 'event.email_draft_created',
    milestone: true,
    severity: 'success',
    node: 'node.email_draft_created',
  },
  email_draft_edited: {
    phase: 'email',
    chat: 'event.email_draft_edited',
    voice: 'user',
    milestone: false,
    severity: 'info',
  },
  email_approved: {
    phase: 'email',
    chat: 'event.email_approved',
    voice: 'user',
    milestone: true,
    severity: 'success',
    node: 'node.email_approved',
  },
  analysis_closed: {
    phase: 'email',
    chat: 'event.analysis_closed',
    milestone: true,
    severity: 'success',
    node: 'node.analysis_closed',
  },
  // Reverting a concluded analysis reopens it. Without saying so, the chat kept the
  // "concluída" bubble and then asked for work, contradicting itself.
  analysis_reopened: {
    phase: 'derived',
    chat: 'event.analysis_reopened',
    milestone: true,
    severity: 'info',
    node: 'node.analysis_reopened',
  },

  // --- paths and reverts ------------------------------------------------------------------
  tracked_back: {
    phase: 'derived',
    chat: 'event.tracked_back',
    voice: 'user',
    milestone: true,
    severity: 'info',
    node: 'node.tracked_back',
  },
  path_forked: { phase: 'documento', chat: 'event.path_forked', milestone: true, severity: 'info', node: 'node.path_forked' },
  // Switching path is navigation, not work: it belongs in neither the chat nor the graph.
  path_switched: { phase: 'derived', chat: null, milestone: false, severity: 'info' },

  // --- cross-cutting ------------------------------------------------------------------------
  potentially_affected: {
    phase: 'revisao',
    chat: 'event.potentially_affected',
    milestone: true,
    severity: 'warning',
    node: 'node.potentially_affected',
  },
  affected_dismissed: { phase: 'revisao', chat: null, milestone: false, severity: 'info' },
  ai_degraded: { phase: 'derived', chat: null, milestone: false, severity: 'warning' },
  error: { phase: 'derived', chat: 'event.error', milestone: true, severity: 'error', node: 'node.error' },
  deleted: { phase: 'derived', chat: null, milestone: false, severity: 'info' },
};

/**
 * The agent's narration of one event. The definition owns both the sentence and how the
 * event's payload fills it, so the chat cannot phrase an event differently from the
 * history graph — they now read the same table.
 */
/**
 * One sentence for a failure, however many times it happened: the count and the remedy ride
 * on the same line rather than becoming messages of their own.
 */
function withFailureDetail(sentence: string, detail: Record<string, unknown>): string {
  const repeated = Number(detail.repeated || 1);
  const remedy = failureRemedy(String(detail.message || ''));
  return (
    sentence +
    (repeated > 1 ? msg('event.failure.repeated', { n: repeated }) : '') +
    (remedy ? msg('event.failure.remedy', { remedy }) : '')
  );
}

export function eventChatSentence(
  kind: string,
  detail: Record<string, unknown> = {},
  type: AnalysisType = 'summary',
): string | null {
  if (!isEventKind(kind)) return null;
  const id = EVENTS[kind].chat;
  if (!id) return null;
  const n = (key: string) => Number(detail[key] || 0);
  const s = (key: string) => String(detail[key] || '');

  switch (kind) {
    case 'created': {
      let sentence = msg('event.created', { document: s('mainDocumentName') || 'o documento' });
      if (n('relatedSelected') > 0) sentence += msg('event.created.related', { n: n('relatedSelected') });
      if (detail.hasInstructions) sentence += msg('event.created.instructions');
      return sentence;
    }
    case 'relations_identified':
      return n('candidates') > 0
        ? msg('event.relations_identified', { n: n('candidates') })
        : msg('event.relations_identified.none');
    case 'run_completed':
      return n('rejected') > 0
        ? msg('event.run_completed.rejected', { accepted: n('accepted'), rejected: n('rejected') })
        : msg('event.run_completed', { accepted: n('accepted') });
    case 'version_set_final':
      return msg('event.version_set_final');
    case 'pdf_conversion_failed':
      return withFailureDetail(msg('event.pdf_conversion_failed', { cause: failureCause(s('message')) }), detail);
    case 'email_draft_created':
      return msg('event.email_draft_created', { pdfName: s('pdfName') });
    case 'potentially_affected':
      return msg('event.potentially_affected', { reason: s('reason') || 'um documento usado nesta análise mudou.' });
    case 'narrative_markers_stripped':
      return msg('event.narrative_markers_stripped', { stripped: n('stripped') });
    case 'items_discarded':
      return msg('event.items_discarded', { n: n('count') });
    case 'tracked_back': {
      const phase = eventPhase(kind, detail);
      return msg('event.tracked_back', {
        phase: phase ? phaseLabel(phase, type) : s('stage'),
        path: s('newPath').toUpperCase(),
      });
    }
    case 'path_forked':
      return msg('event.path_forked', { path: s('newPath').toUpperCase(), fromVersion: s('fromVersion') });
    case 'error': {
      const phase = eventPhase(kind, detail);
      return withFailureDetail(
        msg('event.error', {
          phase: phase ? phaseLabel(phase, type) : s('step'),
          cause: failureCause(s('message')),
        }),
        detail,
      );
    }
    default:
      return msg(id);
  }
}

/** Who says a given event's sentence — the agent narrating, or the user deciding. */
export function eventVoice(kind: string): 'agent' | 'user' {
  return (isEventKind(kind) && EVENTS[kind].voice) || 'agent';
}

/** The short label for this event's card in the history graph. */
export function eventNodeTitle(kind: string): string | null {
  if (!isEventKind(kind)) return null;
  const id = EVENTS[kind].node;
  return id ? msg(id) : null;
}

export function isEventKind(value: string): value is EventKind {
  return Object.prototype.hasOwnProperty.call(EVENTS, value);
}

/** The phase an event belongs to, resolving 'derived' from the event's own payload. */
export function eventPhase(kind: string, detail: Record<string, unknown> = {}): PhaseKey | null {
  if (!isEventKind(kind)) return null;
  const def = EVENTS[kind];
  if (def.phase !== 'derived') return def.phase;
  const named = String(detail.phase || detail.stage || detail.step || '');
  return (PHASE_OF_STEP[named] || (named as PhaseKey)) ?? null;
}

/** Which phase an operation failed in — `error` events carry the step, not the phase. */
export const PHASE_OF_STEP: Record<string, PhaseKey> = {
  identify_relations: 'configuracao',
  run: 'extracao',
  generate: 'documento',
  convert: 'pdf',
  chat: 'revisao',
};

/** Event kinds the timeline renders as a version/conversion/turn card instead. */
export const MATERIALISED_EVENTS: EventKind[] = EVENT_KINDS.filter((kind) => EVENTS[kind].materialised);
