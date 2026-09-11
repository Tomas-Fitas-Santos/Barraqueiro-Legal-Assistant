import { ApiError } from '@/app/api/_helpers';
import { aiConfigured, aiStructured } from '@/lib/server/ai/client';
import { REVISION_TURN_SCHEMA } from '@/lib/server/ai/schemas';
import { crossCheckProposal, type ModelImpact } from '@/lib/server/chat-rules';
import { genId } from '@/lib/server/crypto';
import { getDb } from '@/lib/server/db';
import { buildReferenceList, sanitizeMarkers, type NarrativeSection } from '@/lib/server/docx';
import { assertNotClosed, getAnalysis, listItems, recordEvent } from '@/lib/server/repo/analyses';
import { activePath, latestSectionedVersion, renderVersionFromSections } from '@/lib/server/repo/versions';

// The revision chat (briefing §13): acts ONLY on the open analysis and its latest
// sectioned version. One structured call per message; the model's impact self-assessment
// is cross-checked deterministically (chat-rules.ts) and the stricter verdict wins. A
// gated change parks pending; confirming it creates a NEW immutable version.

export type TurnRow = {
  turnId: string;
  userMessage: string;
  reply: string;
  impact: {
    changeType?: string;
    affectedSections?: string[];
    affectedSources?: string[];
    reasons?: string[];
    appOverrode?: boolean;
  };
  status: 'applied' | 'pending_confirmation' | 'discarded' | 'failed';
  versionId: string;
  pathLetter: string;
  createdAt: number;
};

type DbTurnRow = {
  turn_id: string;
  user_message: string;
  reply: string;
  proposal_json: string;
  impact_json: string;
  status: TurnRow['status'];
  version_id: string;
  path_letter: string;
  created_at: number;
};

function toRow(row: DbTurnRow): TurnRow {
  let impact: TurnRow['impact'] = {};
  try {
    impact = JSON.parse(row.impact_json) as TurnRow['impact'];
  } catch {
    impact = {};
  }
  return {
    turnId: row.turn_id,
    userMessage: row.user_message,
    reply: row.reply,
    impact,
    status: row.status,
    versionId: row.version_id,
    pathLetter: row.path_letter || 'a',
    createdAt: row.created_at,
  };
}

export function listTurns(analysisId: string): TurnRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM analysis_turns WHERE analysis_id = ? ORDER BY created_at')
    .all(analysisId) as DbTurnRow[];
  return rows.map(toRow);
}

function pendingTurn(analysisId: string): DbTurnRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM analysis_turns WHERE analysis_id = ? AND status = 'pending_confirmation' LIMIT 1`)
    .get(analysisId) as DbTurnRow | undefined;
}

export async function sendChatMessage(analysisId: string, message: string): Promise<TurnRow> {
  const analysis = getAnalysis(analysisId);
  if (!analysis || analysis.state === 'eliminada') throw new ApiError('Analysis not found.', 404);
  assertNotClosed(analysisId);
  if (analysis.state === 'alteracao_pendente_de_confirmacao') {
    throw new ApiError('Confirme ou descarte a alteração pendente antes de pedir outra.', 409);
  }
  if (analysis.state !== 'pronta_para_revisao' && analysis.state !== 'aprovada') {
    throw new ApiError(`O chat de revisão atua sobre a análise aberta, não em "${analysis.state}".`, 409);
  }
  const open = latestSectionedVersion(analysisId);
  if (!open) {
    throw new ApiError('Gere primeiro o documento — o chat edita a última versão gerada pela aplicação.', 409);
  }
  if (!(await aiConfigured())) {
    throw new ApiError('AI is not configured — connect ChatGPT in Settings to use the revision chat.', 400);
  }
  const trimmed = String(message || '').trim();
  if (!trimmed) throw new ApiError('Empty message.', 400);

  const items = listItems(analysisId).filter((item) => item.accepted && item.decision !== 'rejected');
  const references = buildReferenceList(items);

  const result = await aiStructured<{
    reply: string;
    affected_sections: string[];
    change_type: string;
    affected_sources: string[];
    removes_factual_content: boolean;
    alters_obligations_deadlines_references: boolean;
    requires_confirmation: boolean;
    sections: NarrativeSection[];
  }>({
    task: 'revise_document',
    instructions: [
      'Apply the user\'s requested change to the narrative document below and return the FULL revised set of sections.',
      'Preserve every [n] citation marker whose content you keep — markers tie prose to verified sources. Never invent new marker numbers.',
      'Assess your own change honestly: does it remove factual content, alter obligations/deadlines/references, or otherwise need explicit confirmation (§13)? When in doubt, say yes.',
      `Numbered references available: ${references.map((r) => `[${r.n}] ${r.document} p.${r.page}`).join('; ') || '(none)'}`,
      `Current document sections (JSON):\n${JSON.stringify(latestSectionedVersion(analysisId)?.sections || [], null, 1)}`,
    ].join('\n'),
    input: [{ type: 'input_text', text: trimmed }],
    schema: REVISION_TURN_SCHEMA,
    reasoningEffort: 'medium',
  });

  // App-side marker hygiene + deterministic cross-check; the stricter verdict wins.
  let strippedTotal = 0;
  const proposedSections = result.sections.map((section) => {
    const cleaned = sanitizeMarkers(section.body, references);
    strippedTotal += cleaned.stripped;
    return { heading: section.heading, body: cleaned.text };
  });
  const check = crossCheckProposal(open.sections, proposedSections, result as ModelImpact);

  const impact = {
    changeType: result.change_type,
    affectedSections: result.affected_sections,
    affectedSources: result.affected_sources,
    reasons: check.reasons,
    appOverrode: check.appOverrode,
    ...(strippedTotal > 0 ? { markersStripped: strippedTotal } : {}),
  };

  const db = getDb();
  const turnId = genId('trn');
  const now = Date.now();

  if (check.gate) {
    db.prepare(
      `INSERT INTO analysis_turns (turn_id, analysis_id, user_message, reply, proposal_json, impact_json, status, path_letter, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending_confirmation', ?, ?)`,
    ).run(
      turnId,
      analysisId,
      trimmed,
      result.reply,
      JSON.stringify(proposedSections),
      JSON.stringify(impact),
      activePath(analysisId),
      now,
    );
    db.prepare('UPDATE analyses SET state = ?, updated_at = ? WHERE analysis_id = ?').run(
      'alteracao_pendente_de_confirmacao',
      now,
      analysisId,
    );
    recordEvent(analysisId, 'chat_change_pending', { turnId, reasons: check.reasons, appOverrode: check.appOverrode });
    return toRow(pendingTurn(analysisId) as DbTurnRow);
  }

  // Harmless change: applies immediately, still as a new immutable version.
  const version = renderVersionFromSections({
    analysisId,
    origin: 'chat_change',
    sections: proposedSections,
    note: `Chat: ${result.change_type} — ${trimmed.slice(0, 120)}`,
  });
  db.prepare(
    `INSERT INTO analysis_turns (turn_id, analysis_id, user_message, reply, proposal_json, impact_json, status, version_id, path_letter, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?)`,
  ).run(
    turnId,
    analysisId,
    trimmed,
    result.reply,
    JSON.stringify(proposedSections),
    JSON.stringify(impact),
    version.versionId,
    version.pathLetter,
    now,
    now,
  );
  recordEvent(analysisId, 'chat_change_applied', { turnId, versionNo: version.versionNo, changeType: result.change_type });
  const row = db.prepare('SELECT * FROM analysis_turns WHERE turn_id = ?').get(turnId) as DbTurnRow;
  return toRow(row);
}

export function decideChatTurn(analysisId: string, turnId: string, decision: 'confirm' | 'discard'): TurnRow {
  const analysis = getAnalysis(analysisId);
  if (!analysis || analysis.state === 'eliminada') throw new ApiError('Analysis not found.', 404);
  const db = getDb();
  const turn = db
    .prepare(`SELECT * FROM analysis_turns WHERE analysis_id = ? AND turn_id = ? AND status = 'pending_confirmation'`)
    .get(analysisId, turnId) as DbTurnRow | undefined;
  if (!turn) throw new ApiError('No pending change with that id.', 404);
  const now = Date.now();

  if (decision === 'discard') {
    db.prepare(`UPDATE analysis_turns SET status = 'discarded', decided_at = ? WHERE turn_id = ?`).run(now, turnId);
    db.prepare('UPDATE analyses SET state = ?, updated_at = ? WHERE analysis_id = ?').run(
      'pronta_para_revisao',
      now,
      analysisId,
    );
    recordEvent(analysisId, 'chat_change_discarded', { turnId });
    const row = db.prepare('SELECT * FROM analysis_turns WHERE turn_id = ?').get(turnId) as DbTurnRow;
    return toRow(row);
  }

  const sections = JSON.parse(turn.proposal_json) as NarrativeSection[];
  const version = renderVersionFromSections({
    analysisId,
    origin: 'chat_change',
    sections,
    note: `Alteração confirmada via chat: ${turn.user_message.slice(0, 120)}`,
  });
  db.prepare(`UPDATE analysis_turns SET status = 'applied', version_id = ?, decided_at = ? WHERE turn_id = ?`).run(
    version.versionId,
    now,
    turnId,
  );
  db.prepare('UPDATE analyses SET state = ?, updated_at = ? WHERE analysis_id = ?').run(
    'pronta_para_revisao',
    now,
    analysisId,
  );
  recordEvent(analysisId, 'chat_change_confirmed', { turnId, versionNo: version.versionNo });
  const row = db.prepare('SELECT * FROM analysis_turns WHERE turn_id = ?').get(turnId) as DbTurnRow;
  return toRow(row);
}
