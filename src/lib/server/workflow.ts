import { ApiError } from '@/app/api/_helpers';
import { aiConfigured } from '@/lib/server/ai/client';
import { getDb } from '@/lib/server/db';
import { getAnalysis, listAnalysisDocuments, listItems, recordEvent } from '@/lib/server/repo/analyses';
import { listConversions } from '@/lib/server/repo/conversions';
import { currentExtraction, extractionItems, pendingLegalDecisions } from '@/lib/server/repo/extractions';
import { listTurns } from '@/lib/server/repo/chat';
import { activePath, latestSectionedVersion, listPaths, listVersions } from '@/lib/server/repo/versions';
import {
  ACTIONS,
  emptyFacts,
  evaluate,
  firstBlocker,
  msg,
  PHASE_OF_STEP,
  type ActionId,
  type ConversionStatus,
  type WorkflowFacts,
  type WorkflowStatus,
} from '@/lib/workflow';

// The bridge between the database and the workflow definition: read the rows, state the
// facts, let the definition decide. Nothing in here makes a judgement about the flow — if
// a rule seems to live here, it belongs in src/lib/workflow instead.

/** Which entries of a path's lineage count: itself, plus its ancestors up to the fork. */
function lineageLetters(
  analysisId: string,
  path: string,
): { letters: Set<string>; order: string[]; until: Map<string, number> } {
  const paths = listPaths(analysisId);
  const byLetter = new Map(paths.map((p) => [p.letter, p]));
  const versions = listVersions(analysisId);
  const versionPath = new Map(versions.map((v) => [v.versionId, { letter: v.pathLetter, at: v.createdAt }]));

  const letters = new Set<string>([path]);
  const order: string[] = [path];
  const until = new Map<string, number>([[path, Number.MAX_SAFE_INTEGER]]);
  let current = byLetter.get(path);
  let hops = 0;
  while (current?.parentVersionId && hops < 26) {
    const parent = versionPath.get(current.parentVersionId);
    if (!parent) break;
    letters.add(parent.letter);
    order.push(parent.letter);
    until.set(parent.letter, current.createdAt || parent.at);
    current = byLetter.get(parent.letter);
    hops += 1;
  }
  return { letters, order, until };
}

function inLineage(letter: string, at: number, lineage: ReturnType<typeof lineageLetters>): boolean {
  if (!lineage.letters.has(letter)) return false;
  return at <= (lineage.until.get(letter) ?? 0);
}

/** A path and its ancestors, newest first — the order an inherited artifact is found in. */
export function lineageOrder(analysisId: string, path?: string): string[] {
  return lineageLetters(analysisId, path || activePath(analysisId)).order;
}

/**
 * Everything the workflow is allowed to know about one path of one analysis.
 *
 * Some facts are stated in terms of what exists today and will be stated in terms of their
 * own column later: `extractionApproved` is currently "the analysis was approved, or a
 * document was generated from it" because generating used to imply acceptance.
 */
export function collectFacts(analysisId: string, path?: string): WorkflowFacts {
  const analysis = getAnalysis(analysisId);
  if (!analysis || analysis.state === 'eliminada') throw new ApiError('Analysis not found.', 404);

  const active = activePath(analysisId);
  const letter = path || active;
  const lineage = lineageLetters(analysisId, letter);

  const documents = listAnalysisDocuments(analysisId).filter((d) => d.role === 'related');
  // The extraction in force for THIS path — its own, or the newest it inherited.
  const extraction = currentExtraction(analysisId, lineage.order);

  /**
   * An INHERITED approval does not survive a revert past it. Reverting to Revisão means
   * "review this again", so a path created that way must not read as already approved just
   * because the path it branched from had approved the same extraction — which is what
   * left a reopened analysis showing every phase still done.
   */
  const pathRow = listPaths(analysisId).find((row) => row.letter === letter);
  const revertedPastApproval =
    Boolean(pathRow?.parentStage) &&
    ['configuracao', 'extracao', 'revisao'].includes(pathRow?.parentStage || '') &&
    extraction?.pathLetter !== letter;
  const approvedForThisPath = Boolean(extraction?.approvedAt) && !revertedPastApproval;
  const items = extraction ? extractionItems(extraction.extractionId) : [];
  const versions = listVersions(analysisId).filter((v) => inLineage(v.pathLetter, v.createdAt, lineage));
  const versionIds = new Set(versions.map((v) => v.versionId));
  const conversions = listConversions(analysisId).filter((c) => versionIds.has(c.versionId));
  const turns = listTurns(analysisId).filter((t) => inLineage(t.pathLetter, t.createdAt, lineage));

  const finalVersion = versions.find((v) => v.isFinal);
  const conversion = finalVersion ? conversions.find((c) => c.versionId === finalVersion.versionId) : undefined;
  const accepted = items.filter((i) => i.accepted);
  const legalPending = extraction ? pendingLegalDecisions(extraction.extractionId) : [];

  const bootEpoch = Number(
    (getDb().prepare("SELECT value FROM settings WHERE key = 'boot_epoch'").get() as { value?: string })?.value || 0,
  );
  const busy = getDb()
    .prepare('SELECT busy_action, busy_started_at FROM analyses WHERE analysis_id = ?')
    .get(analysisId) as { busy_action: string; busy_started_at: number };
  // An operation is in flight if it says so, or if the state is one that only exists while
  // one is running. Generation is the case that needs the marker: it never changes state.
  const busyState =
    Boolean(busy?.busy_action) ||
    analysis.state === 'em_processamento' ||
    analysis.state === 'a_identificar_relacoes';
  const busySince = busy?.busy_started_at || analysis.updatedAt;

  // The last failure names the step it failed in; the definition turns that into a phase.
  const lastError = getDb()
    .prepare("SELECT detail_json FROM analysis_events WHERE analysis_id = ? AND kind = 'error' ORDER BY created_at DESC LIMIT 1")
    .get(analysisId) as { detail_json?: string } | undefined;
  let failedStep = '';
  try {
    failedStep = String((JSON.parse(lastError?.detail_json || '{}') as { step?: string }).step || '');
  } catch {
    failedStep = '';
  }

  return emptyFacts({
    analysisId,
    type: analysis.type,
    state: analysis.state,
    path: letter,
    activePath: active,
    isActivePath: letter === active,

    relatedTotal: documents.length,
    relatedPending: documents.filter((d) => d.status === 'pending').length,
    relatedConfirmed: documents.filter((d) => d.status === 'confirmed').length,

    itemsAccepted: accepted.length,
    itemsRejected: items.length - accepted.length,
    legalDecisionsPending: legalPending.length,
    hasExtraction: Boolean(extraction),
    // Approval is a fact recorded on the artifact, so a later re-run producing a different
    // extraction does not inherit the approval of the one it replaced.
    extractionApproved: approvedForThisPath,

    versionCount: versions.length,
    hasSectionedVersion: Boolean(latestSectionedVersion(analysisId)),
    latestVersionId: versions.length ? versions[versions.length - 1].versionId : '',
    finalVersionId: finalVersion?.versionId || '',

    conversionState: (conversion?.state || 'none') as ConversionStatus,
    conversionId: conversion?.conversionId || '',
    conversionMatchesFinal: Boolean(conversion && finalVersion && conversion.docxSha256 === finalVersion.sha256),
    pdfApproved: conversion?.state === 'aprovado_para_envio',

    emailDraftCreated: Boolean(
      (
        getDb().prepare('SELECT email_draft_json FROM analyses WHERE analysis_id = ?').get(analysisId) as {
          email_draft_json?: string;
        }
      )?.email_draft_json,
    ),
    // The e-mail approval IS the close, so one fact answers both.
    emailApproved: Boolean(analysis.closedAt),

    pendingTurnId: turns.find((t) => t.status === 'pending_confirmation')?.turnId || '',
    potentiallyAffected: analysis.potentiallyAffected,
    affectedReason: analysis.affectedReason,
    aiConfigured: false, // filled in by workflowStatus, which can await
    closed: Boolean(analysis.closedAt),

    busyAction: busy?.busy_action || (busyState ? (analysis.state === 'a_identificar_relacoes' ? 'identify_relations' : 'run') : ''),
    busySince,
    // An operation started before this process booted is known dead, not merely slow.
    interrupted: busyState && bootEpoch > 0 && busySince < bootEpoch,

    failedPhase: analysis.state === 'erro' ? PHASE_OF_STEP[failedStep] || 'extracao' : null,
    failedDetail: analysis.stateDetail,
    now: Date.now(),
  });
}

/** The workflow status for one path — what the client renders instead of guessing. */
export async function workflowStatus(analysisId: string, path?: string): Promise<WorkflowStatus> {
  const facts = collectFacts(analysisId, path);
  facts.aiConfigured = await aiConfigured();
  return evaluate(facts);
}

/**
 * Enforce an action's preconditions. The thrown message is the SAME string the UI shows as
 * the reason the button is disabled, because both come from the precondition.
 */
export async function assertAction(analysisId: string, action: ActionId, path?: string): Promise<WorkflowFacts> {
  const facts = collectFacts(analysisId, path);
  facts.aiConfigured = await aiConfigured();
  const blocker = firstBlocker(action, facts);
  if (blocker) {
    // §5.5 wants the trail to show that the user tried and could not: an attempt refused
    // for a missing AI connection is a fact about the deployment, not a mistyped click.
    if (blocker.id === 'ai_configured') {
      recordEvent(analysisId, 'run_refused', { action, reason: 'ai_not_configured' });
    }
    throw new ApiError(msg(blocker.messageId, blocker.params?.(facts)), blocker.status);
  }
  return facts;
}

/** Whether an action is currently allowed, without throwing. */
export async function canPerform(analysisId: string, action: ActionId, path?: string): Promise<boolean> {
  const facts = collectFacts(analysisId, path);
  facts.aiConfigured = await aiConfigured();
  return firstBlocker(action, facts) === null;
}

export { ACTIONS };
