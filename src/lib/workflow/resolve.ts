import { ANALYSIS_STATE_LABELS, type AnalysisState } from '@/lib/types';
import type { HelpContextId } from '@/lib/help-contexts';
import { ANALYSIS_RESULT_COPY, type WorkBucket } from '@/lib/product-language';
import { ACTIONS, firstBlocker, type ActionId } from '@/lib/workflow/actions';
import type { WorkflowFacts } from '@/lib/workflow/facts';
import { msg, type MessageId, type MessageParams } from '@/lib/workflow/messages';
import { PHASE_KEYS, phaseIndex, phaseLabel, phasesFor, type Actor, type PhaseKey } from '@/lib/workflow/phases';

// The evaluator: facts in, everything the UI needs out. Pure — no database, no clock, no
// imports from the server tree — so the whole flow is unit-testable by writing a fact set.

export type PhaseStatus = 'pending' | 'active' | 'working' | 'blocked' | 'done' | 'failed';

export type WorkflowNotice = {
  id: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  /** An action that resolves the notice, when one exists. */
  action?: ActionId;
  /** A notice the user can decide about and clear. */
  dismissPath?: string;
};

export type WorkflowAction = {
  id: ActionId;
  label: string;
  busyLabel?: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  path: string;
  kind: 'primary' | 'secondary' | 'danger';
  enabled: boolean;
  /** Present iff !enabled — the same sentence the endpoint would answer with. */
  disabledReason?: string;
  disabledReasonId?: string;
  /** Present iff the action destroys work right now. */
  confirm?: string;
  /** The response is a file to download rather than JSON to read. */
  download?: boolean;
};

export type NextTask = {
  bucket: WorkBucket;
  responsible: 'user' | 'application';
  title: string;
  explanation: string;
  consequence: string;
  href: string;
  helpContext: HelpContextId;
  actionId: ActionId | null;
  count: number;
};

export type WorkflowStatus = {
  version: 1;
  analysisId: string;
  state: AnalysisState;
  stateLabel: string;
  path: string;
  activePath: string;
  isActivePath: boolean;
  closed: boolean;
  /** One plain-language answer to “what happens now?”, shared by queue and workspace. */
  nextTask: NextTask;

  phase: {
    key: PhaseKey;
    label: string;
    index: number;
    status: PhaseStatus;
    actor: Actor;
    headline: string;
  };
  phases: Array<{ key: PhaseKey; label: string; status: PhaseStatus }>;

  /** Every action of the current phase, disabled ones included with their reason. */
  actions: WorkflowAction[];
  /** What stops the current phase's primary action. */
  blockers: WorkflowNotice[];
  /** True and relevant, but not blocking. */
  notices: WorkflowNotice[];

  /**
   * Surfaces that exist in every phase rather than belonging to one. The chat is always on
   * screen, so its availability cannot be answered by the current phase's action list —
   * which is why the client used to infer it from the state plus "does a version exist".
   */
  /**
   * Actions that belong to an artifact's card rather than to the phase gate. They are
   * resolved here, not in the component, so the card's label and enabled state are the
   * definition's — and so the anti-drift suite can still check them against the API.
   */
  surfaces: {
    chat: WorkflowAction;
    setFinal: WorkflowAction;
    approvePdf: WorkflowAction;
    approveEmail: WorkflowAction;
  };

  /**
   * Whether anything may be written at all right now. The version and conversion cards
   * carry their own buttons, and without this they offered actions the phase gate had
   * already ruled out — "Aprovar documento" on a card while a change awaited confirmation.
   */
  writes: { allowed: boolean; reason: string };

  progress: { action: string; phase: PhaseKey; startedAt: number; pollAfterMs: number } | null;
  failure: { phase: PhaseKey; message: string; retry: ActionId | null } | null;
};

// --- the ladder: a phase is done when its artifact exists AND has been approved ----------
// This is the whole progress model. Nothing else may decide how far an analysis got.

const LADDER: Array<{ key: PhaseKey; doneWhen: (f: WorkflowFacts) => boolean }> = [
  {
    key: 'configuracao',
    doneWhen: (f) => (f.type === 'summary' ? true : f.relatedPending === 0 && f.relatedConfirmed > 0),
  },
  { key: 'extracao', doneWhen: (f) => f.hasExtraction },
  { key: 'revisao', doneWhen: (f) => f.extractionApproved },
  { key: 'documento', doneWhen: (f) => f.finalVersionId !== '' },
  { key: 'pdf', doneWhen: (f) => f.pdfApproved },
  { key: 'email', doneWhen: (f) => f.emailApproved },
];

/**
 * States that pin the phase regardless of what the ladder sees.
 *
 * Two reasons a state overrides the ladder: an operation in flight is IN its own phase
 * (a re-run is in extraction even though items already exist), and a state that means
 * "not run yet" must win over artifacts left behind by earlier work — otherwise reverting
 * to Extração leaves the analysis showing Revisão, because the old items are still there
 * until the new run replaces them.
 */
/** The phase an operation belongs to while it is running. */
const PHASE_OF_BUSY: Record<string, PhaseKey> = {
  identify_relations: 'configuracao',
  run: 'extracao',
  generate_version: 'documento',
};

const PINNED: Partial<Record<AnalysisState, PhaseKey | ((f: WorkflowFacts) => PhaseKey)>> = {
  rascunho: (f) => (f.type === 'revision' ? 'configuracao' : 'extracao'),
  a_identificar_relacoes: 'configuracao',
  // Still configuring while a document is undecided; once they are all decided the only
  // thing left is the run, so the analysis is already in extraction.
  a_aguardar_confirmacao_de_documentos: (f) =>
    f.relatedPending > 0 || f.relatedConfirmed === 0 ? 'configuracao' : 'extracao',
  em_processamento: 'extracao',
  // A change awaiting confirmation is about the document it would rewrite.
  alteracao_pendente_de_confirmacao: 'documento',
};

export function isBusyState(state: AnalysisState): boolean {
  return state === 'a_identificar_relacoes' || state === 'em_processamento';
}

/**
 * Which phase the analysis is in. An in-flight operation pins the phase to itself; a
 * failure pins it to the phase that failed; otherwise it is the first rung of the ladder
 * that is not done.
 */
export function resolvePhase(facts: WorkflowFacts): PhaseKey {
  if (facts.state === 'erro' && facts.failedPhase) return facts.failedPhase;
  // An operation in flight is IN its own phase, whether or not it moved the state.
  if (facts.busyAction && !facts.interrupted && PHASE_OF_BUSY[facts.busyAction]) {
    return PHASE_OF_BUSY[facts.busyAction];
  }
  const pinned = PINNED[facts.state];
  if (pinned) return typeof pinned === 'function' ? pinned(facts) : pinned;
  const next = LADDER.find((rung) => !rung.doneWhen(facts));
  return next ? next.key : 'email';
}

function phaseStatuses(facts: WorkflowFacts, current: PhaseKey): Record<PhaseKey, PhaseStatus> {
  const currentIndex = phaseIndex(current);
  const out = {} as Record<PhaseKey, PhaseStatus>;
  for (const key of PHASE_KEYS) {
    const index = phaseIndex(key);
    const done = LADDER.find((rung) => rung.key === key)?.doneWhen(facts) ?? false;
    if (index < currentIndex || (done && index !== currentIndex)) out[key] = 'done';
    else if (index > currentIndex) out[key] = 'pending';
    else if (facts.state === 'erro') out[key] = 'failed';
    else if (isBusyState(facts.state) && !facts.interrupted) out[key] = 'working';
    else out[key] = 'active';
  }
  return out;
}

/** The recovery action for a failed phase — never a dead end, and never the wrong one. */
const RECOVERY: Record<PhaseKey, ActionId> = {
  configuracao: 'identify_relations',
  extracao: 'run',
  revisao: 'approve_extraction',
  documento: 'generate_version',
  pdf: 'retry_conversion',
  email: 'approve_email',
};

/** The primary action of each phase — the one whose blocker is the phase's blocker. */
/** The action whose blocker IS the phase's blocker, offered on the gate or on a card. */
function primaryAction(facts: WorkflowFacts, phase: PhaseKey): ActionId {
  const own = offered(facts, phase)[0];
  if (own) return own;
  switch (phase) {
    case 'documento':
      return 'set_final';
    case 'pdf':
      return facts.conversionState === 'erro' ? 'retry_conversion' : 'approve_pdf';
    case 'email':
      return 'approve_email';
    default:
      return 'run';
  }
}

/** The actions offered in each phase, in display order. */
function offered(facts: WorkflowFacts, phase: PhaseKey): ActionId[] {
  // Concluded: nothing to press. Reverting is offered from the Histórico, where the phase
  // to go back to is chosen — a button here could not say which one.
  if (facts.closed) return [];
  // Killed by a restart: the way out is to run the phase's work again.
  if (facts.interrupted) return [RECOVERY[phase]];
  // A change awaiting confirmation is the only thing that can happen until it is decided,
  // and it is decided on the card that shows what would change — so the gate states the
  // rule and offers nothing of its own.
  if (facts.pendingTurnId) return [];
  switch (phase) {
    case 'configuracao':
      return facts.type === 'revision' && facts.relatedTotal === 0 ? ['identify_relations'] : ['run'];
    case 'extracao':
      return ['run'];
    case 'revisao':
      return ['approve_extraction'];
    // Approving an artifact belongs to that artifact's card, which is the only place that
    // can say WHICH one is being approved. The gate keeps the actions no card owns.
    case 'documento':
      return facts.versionCount > 0 ? [] : ['generate_version'];
    case 'pdf':
      return [];
    case 'email':
      return [];
  }
}

function headlineFor(facts: WorkflowFacts, phase: PhaseKey): string {
  if (facts.state === 'eliminada') return msg('state.eliminada.headline');
  if (facts.closed) return msg('phase.email.headline.closed');
  if (facts.state === 'erro') {
    return msg('state.erro.headline', {
      phase: phaseLabel(phase, facts.type),
      detail: facts.failedDetail || 'erro desconhecido',
    });
  }
  if (facts.interrupted) return msg('notice.interrupted');
  if (facts.busyAction === 'generate_version') return msg('notice.generating');
  if (facts.conversionState === 'pendente' || facts.conversionState === 'em_conversao') {
    return msg('notice.converting');
  }
  if (facts.state === 'a_identificar_relacoes') return msg('state.a_identificar_relacoes.headline');
  if (facts.state === 'em_processamento') {
    return msg(facts.type === 'revision' ? 'phase.extracao.headline.revision' : 'phase.extracao.headline.summary');
  }
  if (facts.state === 'alteracao_pendente_de_confirmacao') return msg('state.alteracao_pendente.headline');

  switch (phase) {
    case 'configuracao':
      if (facts.state === 'a_aguardar_confirmacao_de_documentos') return msg('phase.configuracao.headline.confirm');
      return msg(
        facts.type === 'revision' ? 'phase.configuracao.headline.revision' : 'phase.configuracao.headline.summary',
      );
    case 'extracao':
      return msg(facts.type === 'revision' ? 'phase.extracao.headline.revision' : 'phase.extracao.headline.summary');
    case 'revisao':
      return msg('phase.revisao.headline');
    case 'documento':
      return msg('phase.documento.headline');
    case 'pdf':
      return msg('phase.pdf.headline');
    case 'email':
      return msg('phase.email.headline');
  }
}

/**
 * Fill the ids an action's URL needs. An action offered with a `:versionId` still in it is
 * a button that 404s — the gate posts exactly the path it is handed.
 */
function resolvePath(template: string, facts: WorkflowFacts): string {
  const resolved = template
    .replace(':versionId', facts.latestVersionId)
    .replace(':conversionId', facts.conversionId)
    .replace(':turnId', facts.pendingTurnId)
    .replace(':letter', facts.activePath);
  // The artifact this action acts on does not exist yet, so there is no URL to give. An
  // empty id would have produced `/versions//final` — a path that redirects rather than
  // refusing, which is worse than having none.
  return /\/\/|\/$/.test(resolved.replace('://', '')) ? '' : resolved;
}

function renderAction(id: ActionId, facts: WorkflowFacts): WorkflowAction {
  const def = ACTIONS[id];
  const labelId = typeof def.labelId === 'function' ? def.labelId(facts) : def.labelId;
  const blocker = firstBlocker(id, facts);
  const confirmId = def.confirmId?.(facts) || null;
  return {
    id,
    label: msg(labelId),
    busyLabel: def.busyLabelId ? msg(def.busyLabelId) : undefined,
    method: def.method,
    path: resolvePath(def.path(facts.analysisId), facts),
    kind: def.kind,
    enabled: blocker === null,
    disabledReason: blocker ? msg(blocker.messageId, blocker.params?.(facts)) : undefined,
    disabledReasonId: blocker ? blocker.id : undefined,
    confirm: confirmId ? msg(confirmId, { n: facts.itemsAccepted }) : undefined,
    download: def.download,
  };
}

/** The one answer to "can anything be changed right now", and why not. */
function writesAllowed(facts: WorkflowFacts): { allowed: boolean; reason: string } {
  const reason = facts.closed
    ? 'block.writes.closed'
    : !facts.isActivePath
      ? 'block.writes.other_path'
      : facts.pendingTurnId
        ? 'block.writes.pending'
        : facts.busyAction && !facts.interrupted
          ? 'block.writes.busy'
          : null;
  return reason
    ? { allowed: false, reason: msg('block.writes', { reason: msg(reason) }) }
    : { allowed: true, reason: '' };
}

function noticesFor(facts: WorkflowFacts): WorkflowNotice[] {
  const notices: WorkflowNotice[] = [];
  if (!facts.isActivePath) {
    notices.push({
      id: 'viewing_other_path',
      severity: 'info',
      message: msg('notice.viewing_other_path', {
        path: facts.path.toUpperCase(),
        activePath: facts.activePath.toUpperCase(),
      }),
      action: 'switch_path',
    });
  }
  if (facts.potentiallyAffected) {
    notices.push({
      id: 'potentially_affected',
      severity: 'warning',
      message: msg('notice.potentially_affected', { reason: facts.affectedReason }),
      action: 'track_back',
      dismissPath: `/api/analyses/${facts.analysisId}/affected`,
    });
  }
  // Rejected items are an OUTCOME, not a warning that stands forever. The chat says it when
  // it happens and the extraction card carries the counts, so a permanent banner was a third
  // copy of the same fact that nothing could ever clear.
  if (facts.interrupted) {
    notices.push({ id: 'interrupted', severity: 'error', message: msg('notice.interrupted'), action: 'run' });
  }
  if (facts.closed) {
    notices.push({ id: 'closed', severity: 'info', message: msg('notice.closed'), action: 'track_back' });
  }
  return notices;
}

/** Poll only while the agent is actually working — never on a dead operation. */
function nextTaskFor(facts: WorkflowFacts, phase: PhaseKey): NextTask {
  const href = `/analyses/${facts.analysisId}`;
  const resultHelp: HelpContextId =
    facts.type === 'revision' ? 'analysis.extraction.revision' : 'analysis.extraction.summary';
  const task = (
    values: Omit<NextTask, 'href' | 'count'> & { count?: number; href?: string },
  ): NextTask => ({ href, count: 0, ...values });

  if (facts.closed) {
    return task({
      bucket: 'concluded', responsible: 'user', title: 'Análise concluída',
      explanation: 'Todos os resultados e aprovações estão registados.',
      consequence: 'Pode consultar os ficheiros e o histórico completo.',
      helpContext: 'analysis.details', actionId: null,
    });
  }
  if (!facts.isActivePath) {
    return task({
      bucket: 'waiting_user', responsible: 'user', title: 'Voltar ao percurso em curso',
      explanation: 'Está a consultar uma alternativa anterior; as ações pertencem ao percurso atual.',
      consequence: 'Mudar apenas a vista não apaga nem altera versões.',
      helpContext: 'analysis.history', actionId: 'switch_path',
    });
  }
  if (facts.state === 'erro' || facts.interrupted) {
    return task({
      bucket: 'waiting_user', responsible: 'user', title: 'Retomar o trabalho interrompido',
      explanation: facts.failedDetail || 'A operação não terminou e precisa de ser retomada.',
      consequence: 'A tentativa anterior permanece no registo.',
      helpContext: phase === 'extracao' ? resultHelp : 'analysis.return', actionId: RECOVERY[phase],
    });
  }
  if (facts.busyAction || facts.state === 'a_identificar_relacoes' || facts.state === 'em_processamento' ||
      facts.conversionState === 'pendente' || facts.conversionState === 'em_conversao') {
    return task({
      bucket: 'working', responsible: 'application', title: 'A aplicação está a trabalhar',
      explanation: headlineFor(facts, phase), consequence: 'Pode sair desta página e voltar mais tarde.',
      helpContext: phase === 'configuracao' ? 'analysis.relations' : phase === 'pdf' ? 'analysis.pdf' : resultHelp,
      actionId: null,
    });
  }
  if (facts.pendingTurnId) {
    return task({
      bucket: 'waiting_user', responsible: 'user', title: 'Decidir uma alteração pedida',
      explanation: 'A alteração pode mudar conteúdo relevante e não será aplicada sem confirmação.',
      consequence: 'Aceitar cria uma versão nova; rejeitar mantém a versão atual.',
      helpContext: 'analysis.document', actionId: null,
    });
  }

  switch (phase) {
    case 'configuracao':
      if (facts.relatedPending > 0) {
        return task({
          bucket: 'waiting_user', responsible: 'user',
          title: `Confirmar ${facts.relatedPending} documento${facts.relatedPending === 1 ? '' : 's'} de apoio`,
          explanation: 'Cada documento precisa da sua decisão antes de poder ser citado.',
          consequence: 'Os confirmados entram na comparação; os excluídos não são usados.',
          helpContext: 'analysis.relations', actionId: null, count: facts.relatedPending,
        });
      }
      return task({
        bucket: 'waiting_user', responsible: 'user', title: 'Preparar os documentos de apoio',
        explanation: facts.relatedTotal === 0 ? 'A aplicação pode procurar relações para lhe propor.' : 'As fontes estão decididas.',
        consequence: 'Depois desta preparação pode iniciar a leitura dos documentos.',
        helpContext: 'analysis.sources', actionId: facts.relatedTotal === 0 ? 'identify_relations' : 'run',
      });
    case 'extracao':
      return task({
        bucket: 'waiting_user', responsible: 'user', title: 'Iniciar a leitura dos documentos',
        explanation: 'As fontes estão prontas para produzir resultados estruturados e citados.',
        consequence: 'A aplicação trabalha e regressa quando houver resultados para rever.',
        helpContext: 'analysis.sources', actionId: 'run',
      });
    case 'revisao':
      if (facts.legalDecisionsPending > 0) {
        return task({
          bucket: 'waiting_user', responsible: 'user',
          title: `Decidir ${facts.legalDecisionsPending} ponto${facts.legalDecisionsPending === 1 ? '' : 's'} jurídico${facts.legalDecisionsPending === 1 ? '' : 's'}`,
          explanation: 'A aplicação não pode tomar estas decisões jurídicas por si.',
          consequence: 'Todos os pontos precisam de decisão antes da aprovação conjunta.',
          helpContext: resultHelp, actionId: null, count: facts.legalDecisionsPending,
        });
      }
      return task({
        bucket: 'waiting_user', responsible: 'user', title: `Rever ${facts.itemsAccepted} ${ANALYSIS_RESULT_COPY[facts.type].noun}`,
        explanation: ANALYSIS_RESULT_COPY[facts.type].review,
        consequence: 'A aprovação gera um documento apenas com resultados validados e aceites.',
        helpContext: resultHelp, actionId: 'approve_extraction', count: facts.itemsAccepted,
      });
    case 'documento':
      if (!facts.latestVersionId) {
        return task({
          bucket: 'waiting_user', responsible: 'user', title: 'Gerar o documento Word',
          explanation: 'Os resultados estão aprovados, mas ainda não existe um Word.',
          consequence: 'Será criada uma primeira versão para rever.',
          helpContext: 'analysis.document', actionId: 'generate_version',
        });
      }
      return task({
        bucket: 'waiting_user', responsible: 'user', title: 'Rever e aprovar o documento Word',
        explanation: 'Confirme o conteúdo e peça alterações antes de escolher a versão final.',
        consequence: 'A aprovação permite criar o PDF correspondente a esta versão.',
        helpContext: 'analysis.document', actionId: 'set_final', count: facts.versionCount,
      });
    case 'pdf':
      if (facts.conversionState === 'erro' || facts.conversionState === 'desatualizado') {
        return task({
          bucket: 'waiting_user', responsible: 'user', title: 'Voltar a gerar o PDF',
          explanation: 'O PDF falhou ou já não corresponde ao Word aprovado.',
          consequence: 'Será criado um PDF da versão Word atualmente aprovada.',
          helpContext: 'analysis.pdf', actionId: 'retry_conversion',
        });
      }
      return task({
        bucket: 'waiting_user', responsible: 'user', title: 'Rever e aprovar o PDF',
        explanation: 'Verifique o conteúdo e a paginação antes de preparar a entrega.',
        consequence: 'A aprovação permite preparar o rascunho de e-mail.',
        helpContext: 'analysis.pdf', actionId: 'approve_pdf',
      });
    case 'email':
      return task({
        bucket: 'waiting_user', responsible: 'user', title: 'Preparar o rascunho de e-mail',
        explanation: 'O PDF aprovado está pronto para acompanhar um rascunho de Outlook.',
        consequence: 'A aplicação descarrega o rascunho; o envio continua a ser feito por si.',
        helpContext: 'analysis.email', actionId: 'approve_email',
      });
  }
}

function progressFor(facts: WorkflowFacts, phase: PhaseKey) {
  // A conversion runs after its request has returned, so the analysis state says nothing
  // about it; the conversion's own state is what reports it.
  if (facts.conversionState === 'pendente' || facts.conversionState === 'em_conversao') {
    return { action: 'convert', phase: 'pdf' as PhaseKey, startedAt: facts.busySince, pollAfterMs: 2500 };
  }
  if (facts.interrupted) return null;
  if (!isBusyState(facts.state) && !facts.busyAction) return null;
  return { action: facts.busyAction || 'run', phase, startedAt: facts.busySince, pollAfterMs: 2500 };
}


export function evaluate(facts: WorkflowFacts): WorkflowStatus {
  const phase = resolvePhase(facts);
  const statuses = phaseStatuses(facts, phase);
  const primary = primaryAction(facts, phase);
  const blocker = primary ? firstBlocker(primary, facts) : null;

  return {
    version: 1,
    analysisId: facts.analysisId,
    state: facts.state,
    stateLabel: facts.closed ? 'Concluída' : ANALYSIS_STATE_LABELS[facts.state],
    path: facts.path,
    activePath: facts.activePath,
    isActivePath: facts.isActivePath,
    closed: facts.closed,
    nextTask: nextTaskFor(facts, phase),
    phase: {
      key: phase,
      label: phaseLabel(phase, facts.type),
      index: phaseIndex(phase),
      status: blocker && statuses[phase] === 'active' ? 'blocked' : statuses[phase],
      actor: phasesFor(facts.type).find((p) => p.key === phase)?.actor || 'user',
      headline: headlineFor(facts, phase),
    },
    phases: phasesFor(facts.type).map((p) => ({ key: p.key, label: p.label, status: statuses[p.key] })),
    actions: offered(facts, phase).map((id) => renderAction(id, facts)),
    surfaces: {
      chat: renderAction('chat_send', facts),
      setFinal: renderAction('set_final', facts),
      approvePdf: renderAction('approve_pdf', facts),
      approveEmail: renderAction('approve_email', facts),
    },
    writes: writesAllowed(facts),
    blockers: blocker
      ? [
          {
            id: blocker.id,
            severity: 'warning',
            message: msg(blocker.messageId, blocker.params?.(facts)),
          },
        ]
      : [],
    notices: noticesFor(facts),
    progress: progressFor(facts, phase),
    failure:
      facts.state === 'erro'
        ? {
            phase,
            message: msg('state.erro.headline', {
              phase: phaseLabel(phase, facts.type),
              detail: facts.failedDetail || 'erro desconhecido',
            }),
            retry: RECOVERY[phase],
          }
        : facts.interrupted
          ? { phase, message: msg('notice.interrupted'), retry: RECOVERY[phase] }
          : null,
  };
}

/** Re-export so consumers need one import. */
export type { MessageId, MessageParams };
