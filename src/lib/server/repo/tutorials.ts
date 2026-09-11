import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { ApiError } from '@/app/api/_helpers';
import { genId } from '@/lib/server/crypto';
import { getDb } from '@/lib/server/db';
import { originalPath } from '@/lib/server/ingest/store';
import { LEGAL_DATA_DIR } from '@/lib/server/paths';
import { documentKind } from '@/lib/library-layout';
import { TUTORIALS, TUTORIAL_KINDS, TUTORIAL_SCENARIO_VERSION, isTutorialKind, type TutorialKind } from '@/lib/tutorials';

const FIXTURE_DIR = path.join(LEGAL_DATA_DIR, 'tutorials', 'fixtures');

export type TutorialFixture = {
  fixtureId: string;
  kind: TutorialKind;
  sourceDocumentId: string;
  sourceName: string;
  sourceSha256: string;
  sourceMime: string;
  snapshotRelpath: string;
  metadata: Record<string, unknown>;
  createdAt: number;
};

export type TutorialRun = {
  runId: string;
  userEmail: string;
  kind: TutorialKind;
  fixtureId: string;
  currentStep: number;
  demoState: Record<string, unknown>;
  scenarioVersion: number;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type FixtureRow = {
  fixture_id: string; tutorial_kind: TutorialKind; source_document_id: string; source_name: string;
  source_sha256: string; source_mime: string; snapshot_relpath: string; metadata_json: string; created_at: number;
};
type RunRow = {
  run_id: string; user_email: string; tutorial_kind: TutorialKind; fixture_id: string; current_step: number;
  demo_state_json: string; completed_at: number | null; created_at: number; updated_at: number;
};

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function fixtureOf(row: FixtureRow): TutorialFixture {
  return {
    fixtureId: row.fixture_id, kind: row.tutorial_kind, sourceDocumentId: row.source_document_id,
    sourceName: row.source_name, sourceSha256: row.source_sha256, sourceMime: row.source_mime,
    snapshotRelpath: row.snapshot_relpath, metadata: parseObject(row.metadata_json), createdAt: row.created_at,
  };
}

const LEGACY_V4_STEPS: Record<TutorialKind, readonly string[]> = {
  library: [
    'enter-library', 'three-roots', 'open-officials', 'find-source', 'understand-status',
    'open-preview', 'inspect-preview', 'open-relations', 'confirm-relation', 'open-analyses',
    'inspect-analyses', 'return-library', 'open-templates', 'template-kinds', 'edit-template',
    'save-template', 'upload-template', 'open-results', 'result-detail', 'open-origin', 'finish',
  ],
  summary: [
    'new-analysis', 'choose-type', 'choose-main', 'confirm-support', 'start', 'open-work',
    'citation', 'inspect-citation', 'exclusion', 'approve-findings', 'approve-word',
    'approve-pdf', 'prepare-email', 'locate-result', 'finish',
  ],
  revision: [
    'new-analysis', 'choose-type', 'choose-main', 'confirm-support', 'start', 'open-work',
    'citation', 'inspect-citation', 'legal-decision', 'reject-attempt', 'confirm-retry',
    'decide-retry', 'approve-findings', 'approve-word', 'approve-pdf', 'prepare-email', 'finish',
  ],
};

const LEGACY_V3_STEPS: Record<TutorialKind, readonly string[]> = {
  library: [
    'enter-library', 'three-roots', 'open-officials', 'find-source', 'understand-status',
    'open-preview', 'open-relations', 'confirm-relation', 'open-templates', 'template-kinds',
    'edit-template', 'save-template', 'upload-template', 'open-results', 'result-detail',
    'open-origin', 'finish',
  ],
  summary: [
    'new-analysis', 'choose-type', 'choose-main', 'confirm-support', 'start', 'open-work',
    'citation', 'exclusion', 'approve-findings', 'approve-word', 'approve-pdf', 'prepare-email',
    'locate-result', 'finish',
  ],
  revision: [
    'new-analysis', 'choose-type', 'choose-main', 'confirm-support', 'start', 'open-work',
    'citation', 'legal-decision', 'reject-attempt', 'confirm-retry', 'decide-retry',
    'approve-findings', 'approve-word', 'approve-pdf', 'prepare-email', 'finish',
  ],
};

// Scenario v6 separates the final approval from downloading the .eml. Its predecessor is
// exactly the current definition without that newly inserted stable step.
const LEGACY_V5_STEPS = Object.fromEntries(
  TUTORIAL_KINDS.map((kind) => [kind, TUTORIALS[kind].steps.filter((step) => step.id !== 'approve-email').map((step) => step.id)]),
) as unknown as Record<TutorialKind, readonly string[]>;

function runOf(row: RunRow): TutorialRun {
  const demoState = parseObject(row.demo_state_json);
  const storedVersion = Number(demoState._scenarioVersion || 1);
  let currentStep = row.current_step;
  // Scenario upgrades insert training tasks in every journey. Resume old runs by stable
  // step id, never by the now-shifted numeric position.
  if (storedVersion < TUTORIAL_SCENARIO_VERSION) {
    const legacy = storedVersion < 4
      ? LEGACY_V3_STEPS[row.tutorial_kind]
      : storedVersion < 5
        ? LEGACY_V4_STEPS[row.tutorial_kind]
        : LEGACY_V5_STEPS[row.tutorial_kind];
    const oldId = legacy[Math.min(row.current_step, legacy.length - 1)];
    const mapped = TUTORIALS[row.tutorial_kind].steps.findIndex((step) => step.id === oldId);
    if (mapped >= 0) currentStep = mapped;
  }
  demoState._scenarioVersion = TUTORIAL_SCENARIO_VERSION;
  return {
    runId: row.run_id, userEmail: row.user_email, kind: row.tutorial_kind, fixtureId: row.fixture_id,
    currentStep, demoState, scenarioVersion: Math.max(storedVersion, TUTORIAL_SCENARIO_VERSION), completedAt: row.completed_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function listTutorialFixtures(): TutorialFixture[] {
  return (getDb().prepare('SELECT * FROM tutorial_fixtures WHERE active = 1 ORDER BY created_at').all() as FixtureRow[]).map(fixtureOf);
}

export function tutorialFixtureCandidates() {
  const rows = getDb().prepare(
    `SELECT document_id, name, path, mime, sha256, title, doc_type, page_count, updated_at
       FROM documents
      WHERE removed = 0 AND state = 'indexed' AND sha256 != ''
      ORDER BY updated_at DESC`,
  ).all() as Array<{ document_id: string; name: string; path: string; mime: string; sha256: string; title: string; doc_type: string; page_count: number; updated_at: number }>;
  return rows.filter((row) => documentKind(row.path) === 'official').map((row) => ({
    documentId: row.document_id,
    name: row.name,
    title: row.title,
    mime: row.mime,
    sha256: row.sha256,
    docType: row.doc_type,
    pageCount: row.page_count,
    updatedAt: row.updated_at,
    localCopyAvailable: existsSync(originalPath(row.sha256)),
  }));
}

export function tutorialCatalog(userEmail: string) {
  const fixtures = listTutorialFixtures();
  return TUTORIAL_KINDS.map((kind) => {
    const fixture = fixtures.find((entry) => entry.kind === kind) || null;
    const latest = getDb().prepare(
      `SELECT * FROM tutorial_runs WHERE user_email = ? AND tutorial_kind = ? ORDER BY updated_at DESC LIMIT 1`,
    ).get(userEmail, kind) as RunRow | undefined;
    return { ...TUTORIALS[kind], fixture, latestRun: latest ? runOf(latest) : null };
  });
}

/**
 * Copy an already-ingested Library source into the private tutorial area. The copy is
 * content-addressed and created with COPYFILE_EXCL: after selection it is immutable and
 * neither a later OneDrive edit nor a Library deletion changes the tutorial.
 */
export function createTutorialFixture(kind: TutorialKind, documentId: string): TutorialFixture {
  const document = getDb().prepare(
    `SELECT document_id, name, path, mime, sha256, state, title, subject, issued_date,
            effective_date, page_count, doc_type
       FROM documents WHERE document_id = ? AND removed = 0`,
  ).get(documentId) as {
    document_id: string; name: string; path: string; mime: string; sha256: string; state: string;
    title: string; subject: string; issued_date: string; effective_date: string; page_count: number; doc_type: string;
  } | undefined;
  if (!document) throw new ApiError('Documento não encontrado.', 404);
  if (document.state !== 'indexed' || documentKind(document.path) !== 'official') {
    throw new ApiError('Escolha um documento oficial já indexado.', 409);
  }
  const source = originalPath(document.sha256);
  if (!existsSync(source)) throw new ApiError('A cópia local desta fonte não está disponível. Não foi iniciada nova transcrição.', 409);
  const bytes = readFileSync(source);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (document.sha256 && sha256 !== document.sha256) throw new ApiError('A cópia local já não corresponde à versão indexada.', 409);

  const existing = getDb().prepare(
    'SELECT * FROM tutorial_fixtures WHERE tutorial_kind = ? AND source_sha256 = ?',
  ).get(kind, sha256) as FixtureRow | undefined;
  if (existing) return fixtureOf(existing);

  const fixtureId = genId('tfx');
  const extension = path.extname(document.name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
  const relative = path.join('tutorials', 'fixtures', `${fixtureId}-${sha256.slice(0, 16)}${extension}`);
  const destination = path.join(LEGAL_DATA_DIR, relative);
  mkdirSync(FIXTURE_DIR, { recursive: true });
  copyFileSync(source, destination, constants.COPYFILE_EXCL);

  const page = getDb().prepare(
    `SELECT text FROM document_pages WHERE document_id = ? AND trim(text) != '' ORDER BY page LIMIT 1`,
  ).get(documentId) as { text: string } | undefined;
  const metadata = {
    title: document.title || document.name,
    subject: document.subject,
    issuedDate: document.issued_date,
    effectiveDate: document.effective_date,
    pageCount: document.page_count,
    docType: document.doc_type,
    excerpt: page?.text.slice(0, 500) || '',
  };
  const now = Date.now();
  getDb().prepare(
    `INSERT INTO tutorial_fixtures
       (fixture_id, tutorial_kind, source_document_id, source_name, source_sha256, source_mime,
        snapshot_relpath, metadata_json, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(fixtureId, kind, documentId, document.name, sha256, document.mime, relative, JSON.stringify(metadata), now);
  return fixtureOf(getDb().prepare('SELECT * FROM tutorial_fixtures WHERE fixture_id = ?').get(fixtureId) as FixtureRow);
}

function initialValue(expected: unknown) {
  return typeof expected === 'boolean' ? false : typeof expected === 'number' ? 0 : 'pending';
}

function initialDemoState(kind: TutorialKind): Record<string, unknown> {
  const state: Record<string, unknown> = { _scenarioVersion: TUTORIAL_SCENARIO_VERSION };
  for (const step of TUTORIALS[kind].steps) {
    if (!step.interaction || step.interaction.key in state) continue;
    state[step.interaction.key] = initialValue(step.interaction.value);
  }
  return state;
}

export function createTutorialRun(kind: TutorialKind, userEmail: string): TutorialRun {
  const fixture = listTutorialFixtures().find((entry) => entry.kind === kind);
  if (!fixture) throw new ApiError('Este tutorial ainda não tem um documento de treino preparado.', 409);
  const now = Date.now();
  const runId = genId('tur');
  getDb().prepare(
    `INSERT INTO tutorial_runs
       (run_id, user_email, tutorial_kind, fixture_id, current_step, demo_state_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(runId, userEmail, kind, fixture.fixtureId, JSON.stringify(initialDemoState(kind)), now, now);
  return requireTutorialRun(runId, userEmail);
}

export function requireTutorialRun(runId: string, userEmail: string): TutorialRun {
  const row = getDb().prepare('SELECT * FROM tutorial_runs WHERE run_id = ? AND user_email = ?').get(runId, userEmail) as RunRow | undefined;
  if (!row) throw new ApiError('Tutorial não encontrado.', 404);
  return runOf(row);
}

const DEMO_KEYS: Record<TutorialKind, Set<string>> = Object.fromEntries(
  TUTORIAL_KINDS.map((kind) => [
    kind,
    new Set(TUTORIALS[kind].steps.flatMap((step) => step.interaction ? [step.interaction.key] : [])),
  ]),
) as Record<TutorialKind, Set<string>>;

export function updateTutorialRun(
  runId: string,
  userEmail: string,
  input: { action: string; key?: string; value?: unknown },
): TutorialRun {
  const run = requireTutorialRun(runId, userEmail);
  const last = TUTORIALS[run.kind].steps.length - 1;
  let step = run.currentStep;
  let completedAt = run.completedAt;
  let state = { ...run.demoState };
  switch (input.action) {
    case 'next': step = Math.min(last, step + 1); break;
    case 'back': {
      step = Math.max(0, step - 1);
      completedAt = null;
      // Going back means practising that task again. Clear its interaction and everything
      // after it so previously completed state can never skip a step on the second pass.
      for (const later of TUTORIALS[run.kind].steps.slice(step)) {
        if (later.interaction) state[later.interaction.key] = initialValue(later.interaction.value);
      }
      break;
    }
    case 'skip': step = last; completedAt = Date.now(); break;
    case 'complete': step = last; completedAt = Date.now(); break;
    case 'restart': step = 0; completedAt = null; state = initialDemoState(run.kind); break;
    case 'demo': {
      if (!input.key || !DEMO_KEYS[run.kind].has(input.key)) throw new ApiError('Ação de tutorial inválida.', 400);
      state[input.key] = input.value;
      break;
    }
    case 'demo-next': {
      const expected = TUTORIALS[run.kind].steps[step]?.interaction;
      if (!expected || input.key !== expected.key || !Object.is(input.value, expected.value)) {
        throw new ApiError('Ação de tutorial inválida.', 400);
      }
      state[expected.key] = expected.value;
      step = Math.min(last, step + 1);
      break;
    }
    default: throw new ApiError('Ação de tutorial inválida.', 400);
  }
  const now = Date.now();
  getDb().prepare(
    'UPDATE tutorial_runs SET current_step = ?, demo_state_json = ?, completed_at = ?, updated_at = ? WHERE run_id = ?',
  ).run(step, JSON.stringify(state), completedAt, now, runId);
  return requireTutorialRun(runId, userEmail);
}

export function tutorialFixtureBytes(fixtureId: string): { fixture: TutorialFixture; bytes: Buffer } {
  const row = getDb().prepare('SELECT * FROM tutorial_fixtures WHERE fixture_id = ? AND active = 1').get(fixtureId) as FixtureRow | undefined;
  if (!row) throw new ApiError('Documento de treino não encontrado.', 404);
  const fixture = fixtureOf(row);
  const absolute = path.resolve(LEGAL_DATA_DIR, fixture.snapshotRelpath);
  if (!absolute.startsWith(`${path.resolve(FIXTURE_DIR)}${path.sep}`) || !existsSync(absolute)) {
    throw new ApiError('A cópia privada do documento de treino não está disponível.', 404);
  }
  return { fixture, bytes: readFileSync(absolute) };
}

export function fixtureForRun(runId: string, userEmail: string): TutorialFixture {
  const run = requireTutorialRun(runId, userEmail);
  const row = getDb().prepare('SELECT * FROM tutorial_fixtures WHERE fixture_id = ? AND active = 1').get(run.fixtureId) as FixtureRow | undefined;
  if (!row) throw new ApiError('Documento de treino não encontrado.', 404);
  return fixtureOf(row);
}

export function parseTutorialKind(value: unknown): TutorialKind {
  if (!isTutorialKind(value)) throw new ApiError('Tutorial inválido.', 400);
  return value;
}
