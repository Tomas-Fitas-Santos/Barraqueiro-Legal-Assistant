import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadTsModule } from './helpers.mjs';

// The workflow definition, exercised as the shipped source with no server and no database.
// These tests are the safety net for everything built on top of it: if a phase, an event,
// an action or a message ever loses its definition, this suite says so before the app does.

const messages = await loadTsModule('src/lib/workflow/messages.ts');
const phases = await loadTsModule('src/lib/workflow/phases.ts');
const events = await loadTsModule('src/lib/workflow/events.ts');
const actions = await loadTsModule('src/lib/workflow/actions.ts');
const facts = await loadTsModule('src/lib/workflow/facts.ts');
const resolve = await loadTsModule('src/lib/workflow/resolve.ts');
const types = await loadTsModule('src/lib/types.ts');

const F = facts.emptyFacts;

describe('workflow definition — the flow is defined exactly once', () => {
  it('every message referenced by a phase, event or action exists', () => {
    const referenced = new Set();
    for (const phase of phases.PHASES) {
      for (const field of ['promptId', 'placeholderId']) {
        const value = phase.trackBack[field];
        if (typeof value === 'string') referenced.add(value);
        else Object.values(value).forEach((id) => referenced.add(id));
      }
    }
    for (const def of Object.values(events.EVENTS)) if (def.chat) referenced.add(def.chat);
    for (const def of Object.values(actions.ACTIONS)) {
      if (typeof def.labelId === 'string') referenced.add(def.labelId);
      if (def.busyLabelId) referenced.add(def.busyLabelId);
      for (const pc of def.preconditions) referenced.add(pc.messageId);
    }
    for (const id of referenced) {
      assert.ok(messages.isMessageId(id), `message id "${id}" is referenced but not defined`);
    }
  });

  it('every event kind has a phase, and no event points at a phase that does not exist', () => {
    for (const kind of events.EVENT_KINDS) {
      const def = events.EVENTS[kind];
      assert.ok(def, `event "${kind}" has no definition`);
      if (def.phase !== 'derived') {
        assert.ok(phases.PHASE_KEYS.includes(def.phase), `event "${kind}" names unknown phase "${def.phase}"`);
      }
    }
    // Every step an operation can fail in resolves to a real phase — this is what makes an
    // error offer the right recovery instead of always offering "run".
    for (const [step, phase] of Object.entries(events.PHASE_OF_STEP)) {
      assert.ok(phases.PHASE_KEYS.includes(phase), `step "${step}" names unknown phase "${phase}"`);
    }
  });

  it('the two documents are never confused: the DOCX approval is not in the PDF phase', () => {
    // version_set_final flips is_final on a WORD version; no PDF exists at that moment.
    // Filed under 'pdf' it read as though the final PDF had been fixed.
    assert.equal(events.EVENTS.version_set_final.phase, 'documento');
    assert.match(messages.MESSAGES[events.EVENTS.version_set_final.node], /Documento Word/);
    assert.equal(events.EVENTS.pdf_approved.phase, 'pdf');
    assert.match(messages.MESSAGES[events.EVENTS.pdf_approved.node], /PDF final/);
  });

  it('an analysis that ends has an event that says so, and it is the lane’s last card', () => {
    assert.ok(events.EVENT_KINDS.includes('analysis_closed'));
    assert.equal(events.EVENTS.analysis_closed.phase, 'email');
    assert.equal(events.EVENTS.analysis_closed.milestone, true);
    assert.match(messages.MESSAGES[events.EVENTS.analysis_closed.node], /concluída/i);
  });

  it('decisions are spoken by whoever made them', () => {
    // An approval is the user's act; narrating it as the agent's made the app sound like it
    // had decided. The agent keeps the facts it produced.
    for (const kind of ['extraction_approved', 'version_set_final', 'pdf_approved', 'email_approved', 'tracked_back']) {
      assert.equal(events.eventVoice(kind), 'user', `${kind} is the user's decision`);
    }
    for (const kind of ['created', 'run_completed', 'analysis_closed', 'email_draft_created']) {
      assert.equal(events.eventVoice(kind), 'agent', `${kind} is the agent's narration`);
    }
  });

  it('every analysis state resolves to a phase, for both workflow types', () => {
    for (const type of types.ANALYSIS_TYPES) {
      for (const state of types.ANALYSIS_STATES) {
        if (state === 'eliminada') continue;
        const phase = resolve.resolvePhase(F({ type, state }));
        assert.ok(phases.PHASE_KEYS.includes(phase), `state "${state}" (${type}) resolved to "${phase}"`);
      }
    }
  });

  it('both workflow types can revert to every phase, with a resolved restart', () => {
    for (const type of types.ANALYSIS_TYPES) {
      for (const key of phases.PHASE_KEYS) {
        const def = phases.trackBackFor(type, key);
        assert.ok(def, `${type} has no revert contract for "${key}"`);
        assert.ok(['relations', 'run', 'generate', 'review_only'].includes(def.restart));
        assert.ok(types.ANALYSIS_STATES.includes(def.resetsTo));
        assert.ok(messages.isMessageId(def.promptId) && messages.isMessageId(def.placeholderId));
      }
    }
    // The case that used to dead-end: a summary reverting to Configuração asked the server
    // to identify related documents, which it refuses for summaries.
    assert.equal(phases.trackBackFor('summary', 'configuracao').restart, 'run');
    assert.equal(phases.trackBackFor('revision', 'configuracao').restart, 'relations');
  });
});

describe('workflow ladder — how far an analysis got', () => {
  it('a summary walks configuração → extração → revisão → documento → pdf → e-mail', () => {
    const base = { type: 'summary', state: 'rascunho' };
    assert.equal(resolve.resolvePhase(F(base)), 'extracao', 'a summary has nothing to configure');

    assert.equal(
      resolve.resolvePhase(F({ ...base, state: 'pronta_para_revisao', hasExtraction: true })),
      'revisao',
    );
    assert.equal(
      resolve.resolvePhase(F({ ...base, state: 'pronta_para_revisao', hasExtraction: true, extractionApproved: true })),
      'documento',
    );
    assert.equal(
      resolve.resolvePhase(
        F({ ...base, state: 'aprovada', hasExtraction: true, extractionApproved: true, finalVersionId: 'v1' }),
      ),
      'pdf',
    );
    assert.equal(
      resolve.resolvePhase(
        F({
          ...base,
          state: 'aprovada',
          hasExtraction: true,
          extractionApproved: true,
          finalVersionId: 'v1',
          pdfApproved: true,
        }),
      ),
      'email',
    );
  });

  it('a revision starts in configuração until its related documents are decided', () => {
    const base = { type: 'revision', state: 'a_aguardar_confirmacao_de_documentos', relatedTotal: 2 };
    assert.equal(resolve.resolvePhase(F({ ...base, relatedPending: 2 })), 'configuracao');
    assert.equal(resolve.resolvePhase(F({ ...base, relatedPending: 0, relatedConfirmed: 2 })), 'extracao');
  });

  it('an operation in flight pins the phase to itself, even when later work exists', () => {
    // A re-run is IN extraction, not in the phase its old items had reached.
    const facts = F({
      state: 'em_processamento',
      hasExtraction: true,
      extractionApproved: true,
      finalVersionId: 'v1',
    });
    assert.equal(resolve.resolvePhase(facts), 'extracao');
    assert.equal(resolve.evaluate(facts).progress?.pollAfterMs, 2500);
  });

  it('an interrupted operation stops the polling, says what happened, and offers the way out', () => {
    const facts = F({ state: 'em_processamento', interrupted: true, aiConfigured: true });
    const status = resolve.evaluate(facts);
    assert.equal(status.progress, null, 'a dead operation is not polled');
    assert.match(status.phase.headline, /interrompido/i);
    // Killed by a restart is a failure like any other: it gets the phase's recovery.
    assert.equal(status.failure?.retry, 'run');
    assert.ok(status.actions.some((a) => a.id === 'run'));
  });

  it('a failure keeps the phase it failed in, and offers that phase’s recovery', () => {
    const status = resolve.evaluate(
      F({ type: 'revision', state: 'erro', failedPhase: 'configuracao', failedDetail: 'timeout' }),
    );
    assert.equal(status.phase.key, 'configuracao');
    // The bug this prevents: always offering `run`, which 409s for a revision that failed
    // while identifying its related documents.
    assert.equal(status.failure?.retry, 'identify_relations');
  });
});

describe('next task — one plain-language answer for every surface', () => {
  it('separates work waiting for the user, application work and concluded work', () => {
    const waiting = resolve.evaluate(F({ analysisId: 'ana_1', state: 'pronta_para_revisao', hasExtraction: true, itemsAccepted: 4 }));
    assert.equal(waiting.nextTask.bucket, 'waiting_user');
    assert.equal(waiting.nextTask.actionId, 'approve_extraction');
    assert.equal(waiting.nextTask.count, 4);
    assert.match(waiting.nextTask.consequence, /gera um documento/i);

    const working = resolve.evaluate(F({ analysisId: 'ana_2', state: 'em_processamento', busyAction: 'run' }));
    assert.equal(working.nextTask.bucket, 'working');
    assert.equal(working.nextTask.responsible, 'application');

    const concluded = resolve.evaluate(F({ analysisId: 'ana_3', state: 'aprovada', closed: true, emailApproved: true }));
    assert.equal(concluded.nextTask.bucket, 'concluded');
    assert.equal(concluded.nextTask.actionId, null);
  });

  it('turns pending sources and legal decisions into counted work', () => {
    const sources = resolve.evaluate(F({
      analysisId: 'ana_4', type: 'revision', state: 'a_aguardar_confirmacao_de_documentos',
      relatedTotal: 3, relatedPending: 2, relatedConfirmed: 1,
    }));
    assert.equal(sources.nextTask.count, 2);
    assert.equal(sources.nextTask.helpContext, 'analysis.relations');

    const decisions = resolve.evaluate(F({
      analysisId: 'ana_5', type: 'revision', state: 'pronta_para_revisao', hasExtraction: true,
      relatedTotal: 1, relatedConfirmed: 1, itemsAccepted: 8, legalDecisionsPending: 3,
    }));
    assert.equal(decisions.nextTask.count, 3);
    assert.match(decisions.nextTask.title, /3 pontos jurídicos/);
  });
});

describe('workflow actions — one rule, one message', () => {
  it('a disabled action carries the reason the endpoint would answer with', () => {
    const status = resolve.evaluate(
      F({ type: 'revision', state: 'a_aguardar_confirmacao_de_documentos', relatedTotal: 3, relatedPending: 3 }),
    );
    const run = status.actions.find((a) => a.id === 'run');
    assert.equal(run.enabled, false);
    assert.match(run.disabledReason, /Confirme ou exclua/);
    assert.equal(status.blockers[0].message, run.disabledReason, 'the blocker and the button agree');
  });

  it('the legal-decision rule is the same rule for approving and for drafting', () => {
    const facts = F({
      type: 'revision',
      state: 'pronta_para_revisao',
      hasExtraction: true,
      itemsAccepted: 10,
      legalDecisionsPending: 2,
      relatedConfirmed: 1,
    });
    const approve = actions.firstBlocker('approve_extraction', facts);
    const generate = actions.firstBlocker('generate_version', facts);
    assert.equal(approve.id, 'legal_decisions_settled');
    assert.equal(generate.id, 'legal_decisions_settled');
    assert.equal(approve.messageId, generate.messageId, 'the same rule cannot have two wordings');
  });

  it('a re-run warns that it replaces the extraction and its decisions', () => {
    const status = resolve.evaluate(
      F({ state: 'rascunho', aiConfigured: true, hasExtraction: true, itemsAccepted: 42 }),
    );
    const run = status.actions.find((a) => a.id === 'run');
    assert.match(run.confirm, /42 item/);
  });

  it('nothing is actionable on a path you are only viewing', () => {
    const status = resolve.evaluate(
      F({ path: 'b', activePath: 'a', isActivePath: false, state: 'pronta_para_revisao', hasExtraction: true }),
    );
    for (const action of status.actions) {
      assert.equal(action.enabled, false, `${action.id} must not be actionable off the active path`);
    }
    assert.ok(status.notices.some((n) => n.id === 'viewing_other_path'));
  });

  it('a closed analysis is read-only, but reverting is still allowed', () => {
    const closed = F({ closed: true, state: 'aprovada', hasExtraction: true, extractionApproved: true });
    assert.equal(actions.firstBlocker('generate_version', closed).id, 'not_closed');
    assert.equal(actions.firstBlocker('track_back', closed), null, 'reverting is how a closed analysis reopens');
  });

  it('the e-mail draft is gated on the whole §17 chain', () => {
    const base = {
      state: 'aprovada',
      hasExtraction: true,
      extractionApproved: true,
      finalVersionId: 'v1',
    };
    assert.equal(actions.firstBlocker('approve_email', F({ ...base, finalVersionId: '' })).id, 'has_final_version');
    assert.equal(actions.firstBlocker('approve_email', F(base)).id, 'pdf_matches_final');
    assert.equal(
      actions.firstBlocker('approve_email', F({ ...base, conversionMatchesFinal: true, conversionState: 'desatualizado' })).id,
      'pdf_current',
    );
    assert.equal(
      actions.firstBlocker('approve_email', F({ ...base, conversionMatchesFinal: true, conversionState: 'pronto_para_revisao' })).id,
      'pdf_approved',
    );
    assert.equal(
      actions.firstBlocker(
        'approve_email',
        F({ ...base, conversionMatchesFinal: true, conversionState: 'aprovado_para_envio', pdfApproved: true }),
      ),
      null,
    );
  });
});
