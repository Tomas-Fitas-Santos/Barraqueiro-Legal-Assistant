import type { AnalysisState, AnalysisType } from '@/lib/types';
import type { MessageId } from '@/lib/workflow/messages';

// The six phases of an analysis, and what reverting to each one means.
//
// A phase is ALWAYS "the agent produces → the user approves". The agent never carries work
// past a gate on its own, and every approval starts the next agent step automatically.
// Which phase an analysis is in is decided here and nowhere else — the client used to
// derive it from a hardcoded state map plus a walk over the history graph, and the two
// answers could disagree.

export const PHASE_KEYS = ['configuracao', 'extracao', 'revisao', 'documento', 'pdf', 'email'] as const;
export type PhaseKey = (typeof PHASE_KEYS)[number];

/** Who the workflow is waiting for while it sits in a phase. */
export type Actor = 'agent' | 'user';

/** What re-running from a phase actually does. */
export type RestartKind = 'relations' | 'run' | 'generate' | 'review_only';

export type PhaseDef = {
  key: PhaseKey;
  label: string;
  /** Phases whose label differs by workflow type (extracao is "Matriz comparativa"). */
  labelFor?: Partial<Record<AnalysisType, string>>;
  actor: Actor;
  /** The fixed question asked when the user reverts here, and what the revert does. */
  trackBack: {
    promptId: MessageId | Partial<Record<AnalysisType, MessageId>>;
    placeholderId: MessageId | Partial<Record<AnalysisType, MessageId>>;
    /**
     * What restarts. Type-dependent for `configuracao`: a revision re-proposes its related
     * documents, a summary has none to propose and goes straight back to extraction —
     * which is why reverting a summary to Configuração used to dead-end on a 400.
     */
    restart: RestartKind | Partial<Record<AnalysisType, RestartKind>>;
    /** The state the analysis lands in, so the follow-up step is legal immediately. */
    resetsTo: AnalysisState | Partial<Record<AnalysisType, AnalysisState>>;
    /** The extraction is redone, so its items and their decisions are replaced. */
    replacesItems: boolean;
  };
};

export const PHASES: PhaseDef[] = [
  {
    key: 'configuracao',
    label: 'Configuração',
    actor: 'user',
    trackBack: {
      promptId: 'trackback.configuracao.prompt',
      placeholderId: 'trackback.configuracao.placeholder',
      restart: { revision: 'relations', summary: 'run' },
      resetsTo: 'rascunho',
      replacesItems: true,
    },
  },
  {
    key: 'extracao',
    label: 'Extração',
    labelFor: { revision: 'Matriz comparativa' },
    actor: 'agent',
    trackBack: {
      promptId: { summary: 'trackback.extracao.summary.prompt', revision: 'trackback.extracao.revision.prompt' },
      placeholderId: {
        summary: 'trackback.extracao.summary.placeholder',
        revision: 'trackback.extracao.revision.placeholder',
      },
      restart: 'run',
      resetsTo: { summary: 'rascunho', revision: 'a_aguardar_confirmacao_de_documentos' },
      replacesItems: true,
    },
  },
  {
    key: 'revisao',
    label: 'Revisão',
    actor: 'user',
    trackBack: {
      promptId: 'trackback.revisao.prompt',
      placeholderId: 'trackback.revisao.placeholder',
      restart: 'review_only',
      resetsTo: 'pronta_para_revisao',
      replacesItems: false,
    },
  },
  {
    key: 'documento',
    label: 'Documento',
    actor: 'user',
    trackBack: {
      promptId: 'trackback.documento.prompt',
      placeholderId: 'trackback.documento.placeholder',
      restart: 'generate',
      resetsTo: 'pronta_para_revisao',
      replacesItems: false,
    },
  },
  {
    key: 'pdf',
    label: 'PDF final',
    actor: 'user',
    trackBack: {
      promptId: 'trackback.pdf.prompt',
      placeholderId: 'trackback.pdf.placeholder',
      restart: 'generate',
      resetsTo: 'pronta_para_revisao',
      replacesItems: false,
    },
  },
  {
    key: 'email',
    label: 'E-mail',
    actor: 'user',
    trackBack: {
      promptId: 'trackback.email.prompt',
      placeholderId: 'trackback.email.placeholder',
      restart: 'generate',
      resetsTo: 'pronta_para_revisao',
      replacesItems: false,
    },
  },
];

function pick<T>(value: T | Partial<Record<AnalysisType, T>>, type: AnalysisType): T {
  if (value && typeof value === 'object' && ('summary' in value || 'revision' in value)) {
    const byType = value as Partial<Record<AnalysisType, T>>;
    return (byType[type] ?? Object.values(byType)[0]) as T;
  }
  return value as T;
}

export function phaseFor(key: string): PhaseDef | null {
  return PHASES.find((phase) => phase.key === key) || null;
}

export function phaseLabel(key: PhaseKey, type: AnalysisType): string {
  const phase = phaseFor(key);
  if (!phase) return key;
  return phase.labelFor?.[type] || phase.label;
}

export function phaseIndex(key: PhaseKey): number {
  return PHASE_KEYS.indexOf(key);
}

/** The phases of a workflow, in order, with the labels that type uses. */
export function phasesFor(type: AnalysisType): Array<{ key: PhaseKey; label: string; actor: Actor }> {
  return PHASES.map((phase) => ({ key: phase.key, label: phaseLabel(phase.key, type), actor: phase.actor }));
}

export type TrackBackDef = {
  key: PhaseKey;
  label: string;
  promptId: MessageId;
  placeholderId: MessageId;
  restart: RestartKind;
  resetsTo: AnalysisState;
  replacesItems: boolean;
};

/** The revert contract for one phase of one workflow type — all branches resolved. */
export function trackBackFor(type: AnalysisType, key: string): TrackBackDef | null {
  const phase = phaseFor(key);
  if (!phase) return null;
  return {
    key: phase.key,
    label: phaseLabel(phase.key, type),
    promptId: pick(phase.trackBack.promptId, type),
    placeholderId: pick(phase.trackBack.placeholderId, type),
    restart: pick(phase.trackBack.restart, type),
    resetsTo: pick(phase.trackBack.resetsTo, type),
    replacesItems: phase.trackBack.replacesItems,
  };
}

export function trackBacksFor(type: AnalysisType): TrackBackDef[] {
  return PHASE_KEYS.map((key) => trackBackFor(type, key)).filter((def): def is TrackBackDef => def !== null);
}
