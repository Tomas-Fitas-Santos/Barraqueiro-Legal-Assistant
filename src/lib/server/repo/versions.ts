import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ApiError } from '@/app/api/_helpers';
import { aiConfigured, aiStructured } from '@/lib/server/ai/client';
import { NARRATIVE_SCHEMA } from '@/lib/server/ai/schemas';
import { genId } from '@/lib/server/crypto';
import { getDb } from '@/lib/server/db';
import {
  assembleFallbackNarrative,
  buildReferenceList,
  renderDocx,
  sanitizeMarkers,
  type NarrativeSection,
} from '@/lib/server/docx';
import { sha256Of } from '@/lib/server/ingest/pipeline';
import {
  assertNotClosed,
  effectiveGuidance,
  withBusy,
  getAnalysis,
  listItems,
  recordEvent,
  type AnalysisItemRow,
} from '@/lib/server/repo/analyses';
import { getDocumentDetail } from '@/lib/server/repo/library';
import { activeTemplateFor } from '@/lib/server/repo/templates';
import { LEGAL_FILES_DIR } from '@/lib/server/paths';
import { ANALYSIS_TYPE_LABELS } from '@/lib/types';

// The immutable version chain (briefing §12/§14): every generated DOCX, manual upload or
// (phase 6) confirmed chat change is a NEW row; bytes are content-addressed and never
// rewritten. Exactly one final at a time; defining a new final strips the previous one.

const VERSIONS_DIR = path.join(LEGAL_FILES_DIR, 'versions');

export type VersionRow = {
  versionId: string;
  analysisId: string;
  versionNo: number;
  pathLetter: string;
  pathSeq: number;
  label: string; // human identity: v1a, v2a, v1b…
  origin: 'generated' | 'manual' | 'chat_change';
  sha256: string;
  filename: string;
  templateId: string;
  templateVersion: number;
  note: string;
  isFinal: boolean;
  createdAt: number;
};

type DbVersionRow = {
  version_id: string;
  analysis_id: string;
  version_no: number;
  path_letter: string;
  path_seq: number;
  origin: 'generated' | 'manual' | 'chat_change';
  sha256: string;
  filename: string;
  template_id: string;
  template_version: number;
  note: string;
  is_final: number;
  created_at: number;
};

export function versionLabel(pathSeq: number, pathLetter: string): string {
  return `v${pathSeq}${pathLetter}`;
}

function toRow(row: DbVersionRow): VersionRow {
  return {
    versionId: row.version_id,
    analysisId: row.analysis_id,
    versionNo: row.version_no,
    pathLetter: row.path_letter,
    pathSeq: row.path_seq,
    label: versionLabel(row.path_seq, row.path_letter),
    origin: row.origin,
    sha256: row.sha256,
    filename: row.filename,
    templateId: row.template_id,
    templateVersion: row.template_version,
    note: row.note,
    isFinal: Boolean(row.is_final),
    createdAt: row.created_at,
  };
}

export function listVersions(analysisId: string): VersionRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM analysis_versions WHERE analysis_id = ? ORDER BY path_letter, path_seq')
    .all(analysisId) as DbVersionRow[];
  return rows.map(toRow);
}

export type PathRow = {
  letter: string;
  parentVersionId: string;
  parentLabel: string;
  /** The stage the fork restarted from — where the branch leaves its parent. */
  parentStage: string;
  createdAt: number;
};

export function listPaths(analysisId: string): PathRow[] {
  const rows = getDb()
    .prepare(
      'SELECT letter, parent_version_id, parent_stage, created_at FROM analysis_paths WHERE analysis_id = ? ORDER BY letter',
    )
    .all(analysisId) as Array<{ letter: string; parent_version_id: string; parent_stage: string; created_at: number }>;
  return rows.map((row) => {
    let parentLabel = '';
    if (row.parent_version_id) {
      const parent = getDb()
        .prepare('SELECT path_seq, path_letter FROM analysis_versions WHERE version_id = ?')
        .get(row.parent_version_id) as { path_seq: number; path_letter: string } | undefined;
      if (parent) parentLabel = versionLabel(parent.path_seq, parent.path_letter);
    }
    return {
      letter: row.letter,
      parentVersionId: row.parent_version_id,
      parentLabel,
      parentStage: row.parent_stage,
      createdAt: row.created_at,
    };
  });
}

/** The active path and its ancestors, newest first. */
export function pathLineageOf(analysisId: string): string[] {
  const paths = listPaths(analysisId);
  const byLetter = new Map(paths.map((p) => [p.letter, p]));
  const versionPath = new Map(listVersions(analysisId).map((v) => [v.versionId, v.pathLetter]));
  const order: string[] = [];
  let current = byLetter.get(activePath(analysisId));
  let hops = 0;
  while (current && hops < 27) {
    order.push(current.letter);
    const parentLetter = current.parentVersionId ? versionPath.get(current.parentVersionId) : undefined;
    if (!parentLetter) break;
    current = byLetter.get(parentLetter);
    hops += 1;
  }
  return order;
}

export function activePath(analysisId: string): string {
  const row = getDb().prepare('SELECT active_path FROM analyses WHERE analysis_id = ?').get(analysisId) as
    | { active_path: string }
    | undefined;
  return row?.active_path || 'a';
}

/**
 * Fork (phase 9): track back to any version and branch a NEW path from it. The next
 * letter is assigned, the analysis switches to it, and the first document on the new path
 * (v1<letter>) appears when the user next generates or chat-edits — starting from the
 * forked version's narrative, not the abandoned tip's.
 */
export function forkFromVersion(analysisId: string, versionId: string): PathRow {
  const source = getVersion(analysisId, versionId);
  const db = getDb();
  const maxLetter = (db
    .prepare("SELECT COALESCE(MAX(letter), 'a') AS m FROM analysis_paths WHERE analysis_id = ?")
    .get(analysisId) as { m: string }).m;
  const next = String.fromCharCode(maxLetter.charCodeAt(0) + 1);
  if (next > 'z') throw new ApiError('Path letters exhausted (26 forks).', 409);
  const now = Date.now();
  // A fork straight off a version branches at the document itself.
  db.prepare(
    "INSERT INTO analysis_paths (analysis_id, letter, parent_version_id, parent_stage, created_at) VALUES (?, ?, ?, 'documento', ?)",
  ).run(analysisId, next, versionId, now);
  db.prepare('UPDATE analyses SET active_path = ?, updated_at = ? WHERE analysis_id = ?').run(next, now, analysisId);
  recordEvent(analysisId, 'path_forked', { fromVersion: source.label, newPath: next });
  return { letter: next, parentVersionId: versionId, parentLabel: source.label, parentStage: 'documento', createdAt: now };
}

export function switchActivePath(analysisId: string, letter: string): void {
  const db = getDb();
  const exists = db
    .prepare('SELECT 1 FROM analysis_paths WHERE analysis_id = ? AND letter = ?')
    .get(analysisId, letter);
  if (!exists) throw new ApiError('Unknown path.', 404);
  db.prepare('UPDATE analyses SET active_path = ?, updated_at = ? WHERE analysis_id = ?').run(
    letter,
    Date.now(),
    analysisId,
  );
  recordEvent(analysisId, 'path_switched', { path: letter });
}

export function getVersion(analysisId: string, versionId: string): VersionRow {
  const row = getDb()
    .prepare('SELECT * FROM analysis_versions WHERE analysis_id = ? AND version_id = ?')
    .get(analysisId, versionId) as DbVersionRow | undefined;
  if (!row) throw new ApiError('Version not found.', 404);
  return toRow(row);
}

export function versionFilePath(sha256: string): string {
  return path.join(VERSIONS_DIR, sha256);
}

export function readVersionBytes(version: VersionRow): Buffer {
  const filePath = versionFilePath(version.sha256);
  if (!existsSync(filePath)) throw new ApiError('Version file is missing from storage.', 500);
  return readFileSync(filePath);
}

function storeVersionBytes(bytes: Buffer): string {
  const sha = sha256Of(bytes);
  mkdirSync(VERSIONS_DIR, { recursive: true });
  const target = versionFilePath(sha);
  if (!existsSync(target)) {
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, target);
  }
  return sha;
}

// Filename base: keeps accents and letters (unicode), collapses everything else to '_',
// and avoids stuttering prefixes like "Nota_Nota_…".
function docBaseName(raw: string): string {
  let base = raw.replace(/\.(pdf|docx)$/i, '').trim();
  base = base.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'Documento';
  base = base.replace(/^(Nota|Relatorio_Revisao)_\1_/u, '$1_');
  return base;
}

function nextVersionNo(analysisId: string): number {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(version_no), 0) AS n FROM analysis_versions WHERE analysis_id = ?')
    .get(analysisId) as { n: number };
  return row.n + 1;
}

function nextPathSeq(analysisId: string, letter: string): number {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(path_seq), 0) AS n FROM analysis_versions WHERE analysis_id = ? AND path_letter = ?')
    .get(analysisId, letter) as { n: number };
  return row.n + 1;
}

function insertVersion(options: {
  analysisId: string;
  origin: 'generated' | 'manual' | 'chat_change';
  bytes: Buffer;
  baseName: string;
  templateId?: string;
  templateVersion?: number;
  note?: string;
  sections?: NarrativeSection[];
}): VersionRow {
  const db = getDb();
  const sha = storeVersionBytes(options.bytes);
  const versionNo = nextVersionNo(options.analysisId);
  const letter = activePath(options.analysisId);
  const pathSeq = nextPathSeq(options.analysisId, letter);
  const versionId = genId('ver');
  const filename = `${docBaseName(options.baseName)}_${versionLabel(pathSeq, letter)}.docx`;
  db.prepare(
    `INSERT INTO analysis_versions (version_id, analysis_id, version_no, path_letter, path_seq, origin, sha256, filename,
                                    template_id, template_version, note, is_final, sections_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    versionId,
    options.analysisId,
    versionNo,
    letter,
    pathSeq,
    options.origin,
    sha,
    filename,
    options.templateId || '',
    options.templateVersion || 0,
    options.note || '',
    options.sections ? JSON.stringify(options.sections) : '',
    Date.now(),
  );
  // §16: a newer DOCX version makes every live PDF of this analysis "desatualizado" —
  // stale PDFs are never attachable again. (Inline SQL, not the conversions repo, to keep
  // the module graph acyclic.)
  db.prepare(
    `UPDATE conversions SET state = 'desatualizado',
            state_detail = 'Foi criada uma versão mais recente do DOCX.', updated_at = ?
     WHERE analysis_id = ? AND state IN ('pendente','em_conversao','pronto_para_revisao','aprovado_para_envio')`,
  ).run(Date.now(), options.analysisId);
  return getVersion(options.analysisId, versionId);
}

/**
 * The latest sectioned version ON THE ACTIVE PATH — what the revision chat edits. A
 * freshly forked path has no versions yet, so it falls back through the fork's parent
 * version (the whole point of tracking back: continue from THERE, not from the tip).
 */
export function latestSectionedVersion(analysisId: string): { version: VersionRow; sections: NarrativeSection[] } | null {
  const db = getDb();
  let letter = activePath(analysisId);
  for (let hops = 0; hops < 27; hops++) {
    const row = db
      .prepare(
        `SELECT * FROM analysis_versions WHERE analysis_id = ? AND path_letter = ? AND sections_json != ''
         ORDER BY path_seq DESC LIMIT 1`,
      )
      .get(analysisId, letter) as (DbVersionRow & { sections_json: string }) | undefined;
    if (row) {
      try {
        return { version: toRow(row), sections: JSON.parse(row.sections_json) as NarrativeSection[] };
      } catch {
        return null;
      }
    }
    const path = db
      .prepare('SELECT parent_version_id FROM analysis_paths WHERE analysis_id = ? AND letter = ?')
      .get(analysisId, letter) as { parent_version_id: string } | undefined;
    if (!path?.parent_version_id) return null;
    const parent = db
      .prepare(`SELECT * FROM analysis_versions WHERE version_id = ? AND sections_json != ''`)
      .get(path.parent_version_id) as (DbVersionRow & { sections_json: string }) | undefined;
    if (parent) {
      try {
        return { version: toRow(parent), sections: JSON.parse(parent.sections_json) as NarrativeSection[] };
      } catch {
        return null;
      }
    }
    letter = parent ? letter : (db
      .prepare('SELECT path_letter FROM analysis_versions WHERE version_id = ?')
      .get(path.parent_version_id) as { path_letter: string } | undefined)?.path_letter || '';
    if (!letter) return null;
  }
  return null;
}

/**
 * Re-render an EXISTING version's bytes with the current built-in template, in place.
 *
 * The letterhead backfill's half of the work: same version row, same sections, same date it
 * was originally produced on — only the template underneath changes. It deliberately does
 * NOT create a new version, because the point is for the letterhead to read as though it had
 * always been there. Returns null when the version cannot be rebuilt faithfully (no stored
 * sections), so the caller can leave it alone rather than approximate it.
 *
 * Rendering and COMMITTING are separate on purpose — see `commitRerenderedVersion`.
 */
export function rerenderVersionInPlace(
  versionId: string,
): { bytes: Buffer; templateId: string; templateVersion: number } | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM analysis_versions WHERE version_id = ?')
    .get(versionId) as (DbVersionRow & { sections_json: string }) | undefined;
  if (!row || !row.sections_json) return null;
  const analysis = getAnalysis(row.analysis_id);
  if (!analysis) return null;

  let sections: NarrativeSection[];
  try {
    sections = JSON.parse(row.sections_json) as NarrativeSection[];
  } catch {
    return null;
  }

  const items = documentItems(row.analysis_id);
  const template = activeTemplateFor(analysis.type);
  const bytes = renderDocx({
    templateBytes: template.bytes,
    docTitle: analysis.type === 'summary' ? 'Nota Informativa' : 'Relatório de Revisão',
    subtitle: `${ANALYSIS_TYPE_LABELS[analysis.type]} — ${analysis.mainDocumentName}`,
    mainDocument: analysis.mainDocumentName,
    // The day the version was produced, never today: re-rendering must not silently
    // re-date a document the client already has.
    date: new Date(row.created_at).toISOString().slice(0, 10),
    sections,
    references: buildReferenceList(items),
    matrixLines: items
      .filter((item) => item.kind === 'matrix_line')
      .map((item) => ({
        topic: String(item.payload.topic || ''),
        current: String(item.payload.current_content || '—'),
        related: String(item.payload.related_content || ''),
        difference: String(item.payload.difference || ''),
        proposed: String(item.payload.proposed_change || '—'),
        decision: item.decision === 'accepted' ? 'Aceite' : item.decision === 'rejected' ? 'Rejeitada' : 'Pendente',
      })),
  });

  return { bytes, templateId: template.templateId, templateVersion: template.version };
}

/**
 * Record that a re-rendered version is the one the client now has.
 *
 * Separate from the render because the template pin doubles as the backfill's "already
 * done" marker, and writing it at render time made a failed upload mark itself finished:
 * the first production run advanced every pin and then failed to write three of the four
 * files, which left the rows claiming a letterhead the documents did not have and no way
 * for a later run to notice. Nothing is committed until the file the client opens has
 * actually changed.
 */
export function commitRerenderedVersion(
  versionId: string,
  bytes: Buffer,
  templateId: string,
  templateVersion: number,
): void {
  const sha = storeVersionBytes(bytes);
  getDb()
    .prepare('UPDATE analysis_versions SET sha256 = ?, template_id = ?, template_version = ? WHERE version_id = ?')
    .run(sha, templateId, templateVersion, versionId);
}

/** Render + store a new version from a full narrative — shared by generate and the chat. */
export function renderVersionFromSections(options: {
  analysisId: string;
  origin: 'generated' | 'chat_change';
  sections: NarrativeSection[];
  note: string;
}): VersionRow {
  const analysis = getAnalysis(options.analysisId);
  if (!analysis) throw new ApiError('Analysis not found.', 404);
  const items = documentItems(options.analysisId);
  const references = buildReferenceList(items);
  const template = activeTemplateFor(analysis.type, analysis.templateOverride || undefined);
  const bytes = renderDocx({
    templateBytes: template.bytes,
    docTitle: analysis.type === 'summary' ? 'Nota Informativa' : 'Relatório de Revisão',
    subtitle: `${ANALYSIS_TYPE_LABELS[analysis.type]} — ${analysis.mainDocumentName}`,
    mainDocument: analysis.mainDocumentName,
    date: new Date().toISOString().slice(0, 10),
    sections: options.sections,
    references,
    matrixLines: items
      .filter((item) => item.kind === 'matrix_line')
      .map((item) => ({
        topic: String(item.payload.topic || ''),
        current: String(item.payload.current_content || '—'),
        related: String(item.payload.related_content || ''),
        difference: String(item.payload.difference || ''),
        proposed: String(item.payload.proposed_change || '—'),
        decision: item.decision === 'accepted' ? 'Aceite' : item.decision === 'rejected' ? 'Rejeitada' : 'Pendente',
      })),
  });
  const docPart = analysis.mainDocumentName.replace(/\.pdf$/i, '');
  const prefix = analysis.type === 'summary' ? 'Nota' : 'Relatorio_Revisao';
  const baseName = new RegExp(`^${prefix.split('_')[0]}`, 'iu').test(docPart) ? docPart : `${prefix}_${docPart}`;
  return insertVersion({
    analysisId: options.analysisId,
    origin: options.origin,
    bytes,
    baseName,
    templateId: template.templateId,
    templateVersion: template.version,
    note: options.note,
    sections: options.sections,
  });
}

function requireWorkspaceState(analysisId: string): ReturnType<typeof getAnalysis> & object {
  const analysis = getAnalysis(analysisId);
  if (!analysis || analysis.state === 'eliminada') throw new ApiError('Analysis not found.', 404);
  assertNotClosed(analysisId);
  if (!['pronta_para_revisao', 'alteracao_pendente_de_confirmacao', 'aprovada'].includes(analysis.state)) {
    throw new ApiError(`The document workspace opens once the analysis is "pronta_para_revisao" (current: "${analysis.state}").`, 409);
  }
  return analysis;
}

/** Items that go into a document: validator-accepted and not user-rejected. */
function documentItems(analysisId: string): AnalysisItemRow[] {
  return listItems(analysisId).filter((item) => item.accepted && item.decision !== 'rejected');
}

export async function generateVersion(analysisId: string): Promise<VersionRow> {
  return withBusy(analysisId, 'generate_version', () => generateVersionNow(analysisId));
}

async function generateVersionNow(analysisId: string): Promise<VersionRow> {
  const analysis = requireWorkspaceState(analysisId);
  const items = documentItems(analysisId);
  if (items.length === 0) throw new ApiError('There are no validated items to generate from.', 409);

  // The revision matrix must be fully reviewed before drafting (briefing §5.4): every
  // line requiring a legal decision decided — same rule approval enforces.
  if (analysis.type === 'revision') {
    const undecided = items.filter(
      (item) => item.kind === 'matrix_line' && item.payload.requires_legal_decision === true && item.decision === 'pending',
    );
    if (undecided.length > 0) {
      throw new ApiError(`${undecided.length} matrix line(s) require a legal decision before drafting.`, 409);
    }
  }

  const references = buildReferenceList(items);
  let sections: NarrativeSection[];
  let note = '';
  if (await aiConfigured()) {
    const main = getDocumentDetail(analysis.mainDocumentId);
    const itemsBrief = items
      .map((item, i) => {
        const p = item.payload;
        const refKey = `${p.source_document_id}:${p.source_page}:${String(p.source_excerpt).slice(0, 80)}`;
        const ref = references.find((r) => `${r.documentId}:${r.page}:${r.excerpt.slice(0, 80)}` === refKey);
        const text = item.kind === 'matrix_line' ? `${p.topic}: ${p.proposed_change || p.difference}` : String(p.content);
        return `${i + 1}. ${text}${ref ? ` [ref ${ref.n}]` : ' [sem fonte]'}`;
      })
      .join('\n');
    // The guidance of THIS path — including the answer given when the user reverted here,
    // which is the whole point of reverting to Documento and was previously stored and
    // then ignored by the prompt that was supposed to act on it.
    const guidance = effectiveGuidance(analysisId, pathLineageOf(analysisId));
    const result = await aiStructured<{ sections: NarrativeSection[] }>({
      task: 'write_narrative',
      instructions: [
        `Write the narrative document for a ${ANALYSIS_TYPE_LABELS[analysis.type]} of "${main?.title || analysis.mainDocumentName}".`,
        'Use ONLY the validated items below — every factual claim in your prose must come from one of them, citing its reference number as [n] exactly as given. Do not add facts, do not renumber, do not cite anything else.',
        'Structure: an opening section summarising purpose and scope, then thematic sections, then a closing section with next steps if the items support any.',
        guidance ? `Guidance from the user (follow it within the grounding rules):\n${guidance}` : '',
        `Validated items:\n${itemsBrief}`,
      ]
        .filter(Boolean)
        .join('\n'),
      input: [{ type: 'input_text', text: 'Write the sections now.' }],
      schema: NARRATIVE_SCHEMA,
      reasoningEffort: 'medium',
    });
    let stripped = 0;
    sections = result.sections.map((section) => {
      const cleaned = sanitizeMarkers(section.body, references);
      stripped += cleaned.stripped;
      return { heading: section.heading, body: cleaned.text };
    });
    if (stripped > 0) {
      note = `${stripped} marcador(es) de referência inválido(s) removido(s) pela aplicação.`;
      recordEvent(analysisId, 'narrative_markers_stripped', { stripped });
    }
  } else {
    sections = assembleFallbackNarrative(items, references);
    note = 'Narrativa determinística (AI não configurada) — itens validados agrupados por tipo.';
  }

  const version = renderVersionFromSections({ analysisId, origin: 'generated', sections, note });
  recordEvent(analysisId, 'version_generated', {
    versionNo: version.versionNo,
    template: `${version.templateId} v${version.templateVersion}`,
    references: references.length,
    note,
  });
  return version;
}

/** §14: a manually edited DOCX re-uploaded as a NEW version — never replaces anything. */
export function addManualVersion(analysisId: string, bytes: Buffer): VersionRow {
  const analysis = requireWorkspaceState(analysisId);
  // A .docx is a zip: PK\x03\x04. Reject anything else outright.
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new ApiError('The uploaded file is not a .docx document.', 400);
  }
  const manualDocPart = analysis.mainDocumentName.replace(/\.pdf$/i, '');
  const manualPrefix = analysis.type === 'summary' ? 'Nota' : 'Relatorio_Revisao';
  const version = insertVersion({
    analysisId,
    origin: 'manual',
    bytes,
    baseName: new RegExp(`^${manualPrefix.split('_')[0]}`, 'iu').test(manualDocPart) ? manualDocPart : `${manualPrefix}_${manualDocPart}`,
    note: 'Versão editada manualmente',
  });
  recordEvent(analysisId, 'version_uploaded_manual', { versionNo: version.versionNo, sha256: version.sha256 });
  return version;
}

/** §14 rules: only one final at a time; setting a new one strips the previous. */
export function setFinalVersion(analysisId: string, versionId: string): VersionRow {
  requireWorkspaceState(analysisId);
  const version = getVersion(analysisId, versionId);
  const db = getDb();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE analysis_versions SET is_final = 0 WHERE analysis_id = ?').run(analysisId);
    db.prepare('UPDATE analysis_versions SET is_final = 1 WHERE analysis_id = ? AND version_id = ?').run(
      analysisId,
      versionId,
    );
    // §17: a new final invalidates the PDF of the version it replaced. Without this, a
    // conversion of a now-superseded version kept reading "PDF pronto para revisão" — the
    // draft gate would never attach it, but the card said otherwise.
    db.prepare(
      `UPDATE conversions SET state = 'desatualizado',
              state_detail = 'Outra versão passou a ser a final.', updated_at = ?
       WHERE analysis_id = ? AND version_id <> ?
         AND state IN ('pendente','em_conversao','pronto_para_revisao','aprovado_para_envio')`,
    ).run(Date.now(), analysisId, versionId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  recordEvent(analysisId, 'version_set_final', { versionNo: version.versionNo, label: version.label });
  return getVersion(analysisId, versionId);
}
