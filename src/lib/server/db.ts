import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { genId, hashPassword } from '@/lib/server/crypto';
import { LEGAL_DATA_DIR, LEGAL_DB_PATH, LEGAL_FILES_DIR } from '@/lib/server/paths';
import { migrateEncryptSecrets } from '@/lib/server/secrets';
import { foldPt } from '@/lib/text-normalize';

// Single SQLite database via node:sqlite (ships with Node 22 — no native build step).
// WAL + NORMAL sync + busy_timeout is the proven Naten pattern. Tables land in the phase
// that first uses them; phase 0 needs only users + settings.

let db: DatabaseSync | null = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  user_id       TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  password_hash TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_login_at INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The OneDrive library mirror. One row per FILE in the library folder (subfolders are
-- paths, not rows). The state vocabulary covers the whole ingestion pipeline from day one
-- so later phases never need a CHECK rebuild: phase 1 uses 'listed'; phase 2 moves rows
-- through downloaded -> processing -> indexed / failed. 'removed' is a flag, not a state —
-- a removed document keeps its last pipeline state for history.
CREATE TABLE IF NOT EXISTS documents (
  document_id       TEXT PRIMARY KEY,
  drive_item_id     TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  path              TEXT NOT NULL DEFAULT '',
  mime              TEXT NOT NULL DEFAULT '',
  size              INTEGER NOT NULL DEFAULT 0,
  etag              TEXT NOT NULL DEFAULT '',
  ctag              TEXT NOT NULL DEFAULT '',
  web_url           TEXT NOT NULL DEFAULT '',
  sha256            TEXT NOT NULL DEFAULT '',
  drive_modified_at INTEGER NOT NULL DEFAULT 0,
  state             TEXT NOT NULL DEFAULT 'listed'
                    CHECK (state IN ('listed','downloaded','processing','indexed','failed')),
  state_detail      TEXT NOT NULL DEFAULT '',
  removed           INTEGER NOT NULL DEFAULT 0,
  synced_at         INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_state ON documents (removed, state);

-- Page-anchored text: the app's own ground truth for every citation check. "ocr" marks
-- text that came from the vision path; "pending_ocr" marks scanned pages whose OCR has
-- not run yet (no AI configured at ingest time).
CREATE TABLE IF NOT EXISTS document_pages (
  document_id TEXT NOT NULL,
  page        INTEGER NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  ocr         INTEGER NOT NULL DEFAULT 0,
  pending_ocr INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (document_id, page)
);

-- Permanent OCR cache keyed by CONTENT hash + page: a scanned page is OCR'd once ever,
-- across re-syncs, re-uploads and even the same file appearing as a different document.
CREATE TABLE IF NOT EXISTS ocr_cache (
  sha256     TEXT NOT NULL,
  page       INTEGER NOT NULL,
  text       TEXT NOT NULL,
  model      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (sha256, page)
);

-- The library's folders, as the delta feed reports them. Folders used to exist only as
-- path strings on documents, which meant (a) an empty folder was invisible and (b) an
-- incremental delta that returned a file without its parent filed it at the root — enough
-- to make a generated PDF look like client source material.
CREATE TABLE IF NOT EXISTS drive_folders (
  folder_id  TEXT PRIMARY KEY,
  parent_id  TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  removed    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drive_folders_path ON drive_folders (removed, path);

-- The one-time move of the client's pre-existing material into "1. Documentos oficiais".
-- One row per item attempted, written whether it moved or not: the migration runs item by
-- item against a live drive, so a partial run has to leave a record of which half happened.
-- The plan itself is never stored — it is recomputed from current state, which is what
-- makes a re-run pick up exactly the remainder.
CREATE TABLE IF NOT EXISTS migration_log (
  entry_id   TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  from_path  TEXT NOT NULL,
  to_path    TEXT NOT NULL,
  status     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  documents  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- Matching a generated file back to the conversion that produced it joins on content hash.
CREATE INDEX IF NOT EXISTS idx_documents_sha ON documents (sha256);
CREATE INDEX IF NOT EXISTS idx_documents_path ON documents (removed, path);

-- One PDF rendition per piece of CONTENT. Keyed on the source hash, like ocr_cache, which
-- is what makes a stale rendition impossible: edited content has a new hash and converts
-- afresh. pages_json holds the authoritative page text when the APP generated the PDF
-- (an e-mail, a text file) — there is nothing to be gained by reading our own words back.
CREATE TABLE IF NOT EXISTS renditions (
  source_sha256 TEXT PRIMARY KEY,
  pdf_sha256    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  pages_json    TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);

-- Page-anchored paragraph segments + their FTS5 index (kept in sync by triggers).
CREATE TABLE IF NOT EXISTS segments (
  segment_id  TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  page        INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  text        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segments_doc ON segments (document_id, page, seq);

-- The local encoder's output, cached by the bytes it read (briefing §7: never repeat an
-- embedding when the hash has not changed). Keyed by kind too, because e5 is asymmetric —
-- the same text encoded as a query and as a passage are different vectors.
CREATE TABLE IF NOT EXISTS embedding_cache (
  text_sha256 TEXT NOT NULL,
  model       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  vec         BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (text_sha256, model, kind)
);

-- The deterministic half of relation discovery, cached (briefing §7 step 10). Recomputed
-- when the sweep drains rather than when an analysis asks, so a processed document already
-- knows its relations. Rows are a CACHE: dropping the table costs a recomputation, nothing
-- more, and no user decision lives here.
CREATE TABLE IF NOT EXISTS relation_candidates (
  from_document_id TEXT NOT NULL,
  to_document_id   TEXT NOT NULL,
  score            REAL NOT NULL DEFAULT 0,
  evidence_json    TEXT NOT NULL,
  computed_at      INTEGER NOT NULL,
  PRIMARY KEY (from_document_id, to_document_id)
);

-- Which PAIRS have been compared, and at which content versions (§7 step 10, workstream F).
--
-- The predecessor was a boolean on the document, relations_dirty, which could only say
-- "something changed somewhere" — so any change re-judged a document against the entire
-- library, including every pair already compared and unchanged since. It also could not
-- survive a partial sweep: a run that got through half the library left the flag set, and
-- the next run started from the beginning.
--
-- A fingerprint is the document content the comparison actually reads. Two documents are
-- covered when BOTH ends are recorded at their current fingerprints; anything else is an
-- uncompared pair, which is the same statement whether the document is new, was edited, or
-- was simply never reached.
CREATE TABLE IF NOT EXISTS relation_coverage (
  from_document_id TEXT NOT NULL,
  to_document_id   TEXT NOT NULL,
  from_fingerprint TEXT NOT NULL,
  to_fingerprint   TEXT NOT NULL,
  computed_at      INTEGER NOT NULL,
  PRIMARY KEY (from_document_id, to_document_id)
);

-- Documental relations (briefing §9): directed edges between library documents. An edge
-- is proposed (by the engine or the AI judgement) or added manually, then confirmed or
-- rejected by the user — only CONFIRMED edges feed the revision workflow. evidence_json
-- records WHY (reference hits, title mentions, topic overlap, AI rationale + citation).
CREATE TABLE IF NOT EXISTS relations (
  relation_id      TEXT PRIMARY KEY,
  from_document_id TEXT NOT NULL,
  to_document_id   TEXT NOT NULL,
  type             TEXT NOT NULL,
  evidence_json    TEXT NOT NULL DEFAULT '{}',
  proposed_by      TEXT NOT NULL DEFAULT 'engine' CHECK (proposed_by IN ('engine','ai','user')),
  status           TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','rejected')),
  decided_at       INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (from_document_id, to_document_id, type)
);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations (from_document_id, status);
CREATE INDEX IF NOT EXISTS idx_relations_to ON relations (to_document_id, status);

-- Analyses (briefing §5/§6): the two workflows. States verbatim from the briefing; an
-- analysis is soft-deleted ('eliminada'), never dropped — the Histórico requirement.
CREATE TABLE IF NOT EXISTS analyses (
  analysis_id          TEXT PRIMARY KEY,
  type                 TEXT NOT NULL CHECK (type IN ('summary','revision')),
  main_document_id     TEXT NOT NULL,
  state                TEXT NOT NULL DEFAULT 'rascunho'
                       CHECK (state IN ('rascunho','a_identificar_relacoes','a_aguardar_confirmacao_de_documentos',
                                        'em_processamento','pronta_para_revisao','alteracao_pendente_de_confirmacao',
                                        'aprovada','erro','eliminada')),
  state_detail         TEXT NOT NULL DEFAULT '',
  potentially_affected INTEGER NOT NULL DEFAULT 0,
  affected_reason      TEXT NOT NULL DEFAULT '',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analyses_state ON analyses (state, updated_at);

-- The document set of an analysis: the main document plus the related documents, each
-- individually confirmed or excluded by the user BEFORE any generation (briefing §5.3).
CREATE TABLE IF NOT EXISTS analysis_documents (
  analysis_id   TEXT NOT NULL,
  document_id   TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'related' CHECK (role IN ('main','related')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','excluded')),
  relation_type TEXT NOT NULL DEFAULT '',
  decided_at    INTEGER,
  PRIMARY KEY (analysis_id, document_id)
);
-- "Which analyses used this document" — the Library's Análises tab. The PK leads with
-- analysis_id, so the reverse direction was a full scan.
CREATE INDEX IF NOT EXISTS idx_analysis_documents_doc ON analysis_documents (document_id);

-- Validated structured items (briefing §10): summary statements or matrix lines. The
-- payload is the full validated object; accepted=0 keeps validator-rejected items with
-- their reason, for honesty. "decision" is the USER's per-line call on matrix review.
CREATE TABLE IF NOT EXISTS analysis_items (
  item_id          TEXT PRIMARY KEY,
  analysis_id      TEXT NOT NULL,
  seq              INTEGER NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('statement','matrix_line')),
  payload_json     TEXT NOT NULL,
  accepted         INTEGER NOT NULL DEFAULT 1,
  rejection_reason TEXT NOT NULL DEFAULT '',
  decision         TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','accepted','rejected')),
  decided_at       INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analysis_items ON analysis_items (analysis_id, seq);

-- The structured output of one extraction run (briefing §10), as an IMMUTABLE artifact —
-- the same shape as analysis_versions, for the same reason. It is what the user approves,
-- as a whole, before any document is written; a re-run or a manual edit appends a new row
-- rather than overwriting, so a decision is never silently replaced by a later attempt.
CREATE TABLE IF NOT EXISTS analysis_extractions (
  extraction_id  TEXT PRIMARY KEY,
  analysis_id    TEXT NOT NULL,
  path_letter    TEXT NOT NULL DEFAULT 'a',
  seq            INTEGER NOT NULL,
  origin         TEXT NOT NULL DEFAULT 'agent' CHECK (origin IN ('agent','manual')),
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  approved_at    INTEGER,
  approved_by    TEXT NOT NULL DEFAULT '',
  rejected_at    INTEGER,
  rejected_by    TEXT NOT NULL DEFAULT '',
  rejection_reason TEXT NOT NULL DEFAULT '',
  note           TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analysis_extractions ON analysis_extractions (analysis_id, path_letter, seq);

-- The full audit trail (briefing §5.5): everything that happened to an analysis.
CREATE TABLE IF NOT EXISTS analysis_events (
  event_id    TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analysis_events ON analysis_events (analysis_id, created_at);

-- Immutable document versions of an analysis (briefing §12/§14): every generated DOCX,
-- manual upload or confirmed chat change is a NEW row; bytes are content-addressed on
-- disk by sha256 and never rewritten. Exactly one version may be final at a time.
CREATE TABLE IF NOT EXISTS analysis_versions (
  version_id       TEXT PRIMARY KEY,
  analysis_id      TEXT NOT NULL,
  version_no       INTEGER NOT NULL,
  origin           TEXT NOT NULL CHECK (origin IN ('generated','manual','chat_change')),
  sha256           TEXT NOT NULL,
  filename         TEXT NOT NULL,
  template_id      TEXT NOT NULL DEFAULT '',
  template_version INTEGER NOT NULL DEFAULT 0,
  note             TEXT NOT NULL DEFAULT '',
  is_final         INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  UNIQUE (analysis_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_versions ON analysis_versions (analysis_id, version_no);

-- The Word template registry (briefing §12). Template FILES live in the repo under
-- templates/ and are seeded here at boot; a changed file bumps the version (new row) —
-- documents already generated keep their template_id+version+sha and are never touched.
CREATE TABLE IF NOT EXISTS templates (
  template_id   TEXT NOT NULL,
  version       INTEGER NOT NULL,
  name          TEXT NOT NULL,
  analysis_type TEXT NOT NULL CHECK (analysis_type IN ('summary','revision')),
  file_sha256   TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  required_fields_json TEXT NOT NULL DEFAULT '[]',
  fill_rules    TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (template_id, version)
);

-- Revision-chat turns (briefing §13): one row per exchange. A turn that trips a
-- confirmation gate parks as pending_confirmation with its full proposal; confirming
-- applies it as a NEW version, discarding leaves no trace on the document. The chat only
-- ever acts on the open analysis + latest sectioned version.
CREATE TABLE IF NOT EXISTS analysis_turns (
  turn_id       TEXT PRIMARY KEY,
  analysis_id   TEXT NOT NULL,
  user_message  TEXT NOT NULL,
  reply         TEXT NOT NULL DEFAULT '',
  proposal_json TEXT NOT NULL DEFAULT '',
  impact_json   TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'applied'
                CHECK (status IN ('applied','pending_confirmation','discarded','failed')),
  version_id    TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  decided_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_turns ON analysis_turns (analysis_id, created_at);

-- DOCX -> PDF conversions (briefing §12 "Conversão para PDF" + §16). One row per
-- conversion attempt of a specific DOCX version, hash-bound both ways; states verbatim.
-- A PDF whose source DOCX version is superseded turns desatualizado and can never be
-- attached again.
CREATE TABLE IF NOT EXISTS conversions (
  conversion_id   TEXT PRIMARY KEY,
  analysis_id     TEXT NOT NULL,
  version_id      TEXT NOT NULL,
  docx_sha256     TEXT NOT NULL,
  onedrive_docx_id TEXT NOT NULL DEFAULT '',
  onedrive_pdf_id TEXT NOT NULL DEFAULT '',
  pdf_sha256      TEXT NOT NULL DEFAULT '',
  pdf_filename    TEXT NOT NULL DEFAULT '',
  pdf_size        INTEGER NOT NULL DEFAULT 0,
  pdf_pages       INTEGER NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'pendente'
                  CHECK (state IN ('pendente','em_conversao','pronto_para_revisao','aprovado_para_envio','erro','desatualizado')),
  state_detail    TEXT NOT NULL DEFAULT '',
  approved_by     TEXT NOT NULL DEFAULT '',
  approved_at     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversions ON conversions (analysis_id, created_at);

-- Workflow paths (fork support): "a" is every analysis's first path; tracking back to an
-- earlier version and branching creates the next letter, anchored to its parent version.
-- Version identity for humans is path_seq + letter (v1a, v2a, v1b…); version_no remains
-- the global creation order for audit.
CREATE TABLE IF NOT EXISTS analysis_paths (
  analysis_id       TEXT NOT NULL,
  letter            TEXT NOT NULL,
  parent_version_id TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (analysis_id, letter)
);

-- Private, immutable tutorial material. A fixture is a byte-for-byte snapshot of an
-- existing Library document, stored below LEGAL_DATA_DIR rather than in Git or the image.
CREATE TABLE IF NOT EXISTS tutorial_fixtures (
  fixture_id         TEXT PRIMARY KEY,
  tutorial_kind      TEXT NOT NULL CHECK (tutorial_kind IN ('library','summary','revision')),
  source_document_id TEXT NOT NULL,
  source_name        TEXT NOT NULL,
  source_sha256      TEXT NOT NULL,
  source_mime        TEXT NOT NULL,
  snapshot_relpath   TEXT NOT NULL UNIQUE,
  metadata_json      TEXT NOT NULL DEFAULT '{}',
  active             INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  UNIQUE (tutorial_kind, source_sha256)
);

-- Every restart is a new isolated simulation. Runs never reference analyses, versions,
-- relations or conversions and therefore cannot mutate any real workflow row.
CREATE TABLE IF NOT EXISTS tutorial_runs (
  run_id          TEXT PRIMARY KEY,
  user_email      TEXT NOT NULL,
  tutorial_kind   TEXT NOT NULL CHECK (tutorial_kind IN ('library','summary','revision')),
  fixture_id      TEXT NOT NULL,
  current_step    INTEGER NOT NULL DEFAULT 0,
  demo_state_json TEXT NOT NULL DEFAULT '{}',
  completed_at    INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tutorial_runs_user ON tutorial_runs (user_email, tutorial_kind, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
  text, content='segments', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS segments_fts_insert AFTER INSERT ON segments BEGIN
  INSERT INTO segments_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS segments_fts_delete AFTER DELETE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS segments_fts_update AFTER UPDATE OF text ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO segments_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`;

// Idempotent column add: SQLite has no "ADD COLUMN IF NOT EXISTS", so probe table_info
// first. Unused in phase 0; every later schema change goes through this or a documented
// table-rebuild migration, never an ad-hoc ALTER.
export function migrateAddColumn(database: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

type BackfillEvent = { event_id: string; kind: string; detail_json: string };

/**
 * One-time backfill of analysis_events.path_letter / analysis_turns.path_letter /
 * analysis_paths.parent_stage for rows written before those columns existed. Walks each
 * analysis in order applying the same rule the client used to apply at read time: the
 * active path moves on a fork and on an explicit switch, and the forking event itself
 * belongs to the path it created.
 */
function backfillPathStamps(database: DatabaseSync): void {
  const pending = database
    .prepare("SELECT DISTINCT analysis_id FROM analysis_events WHERE path_letter = ''")
    .all() as Array<{ analysis_id: string }>;
  const setEvent = database.prepare('UPDATE analysis_events SET path_letter = ? WHERE event_id = ?');
  for (const { analysis_id } of pending) {
    const rows = database
      .prepare('SELECT event_id, kind, detail_json FROM analysis_events WHERE analysis_id = ? ORDER BY created_at, rowid')
      .all(analysis_id) as BackfillEvent[];
    let current = 'a';
    for (const row of rows) {
      let detail: Record<string, unknown> = {};
      try {
        detail = JSON.parse(row.detail_json) as Record<string, unknown>;
      } catch {
        detail = {};
      }
      if (row.kind === 'tracked_back' || row.kind === 'path_forked') current = String(detail.newPath || current);
      else if (row.kind === 'path_switched') current = String(detail.path || current);
      setEvent.run(current, row.event_id);
    }
  }

  const turns = database
    .prepare("SELECT turn_id, analysis_id, version_id, created_at FROM analysis_turns WHERE path_letter = ''")
    .all() as Array<{ turn_id: string; analysis_id: string; version_id: string; created_at: number }>;
  for (const turn of turns) {
    let letter = '';
    if (turn.version_id) {
      const version = database
        .prepare('SELECT path_letter FROM analysis_versions WHERE version_id = ?')
        .get(turn.version_id) as { path_letter: string } | undefined;
      letter = version?.path_letter || '';
    }
    if (!letter) {
      const near = database
        .prepare(
          `SELECT path_letter FROM analysis_events WHERE analysis_id = ? AND created_at <= ? AND path_letter <> ''
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(turn.analysis_id, turn.created_at) as { path_letter: string } | undefined;
      letter = near?.path_letter || 'a';
    }
    database.prepare('UPDATE analysis_turns SET path_letter = ? WHERE turn_id = ?').run(letter, turn.turn_id);
  }

  const forks = database
    .prepare("SELECT analysis_id, letter FROM analysis_paths WHERE parent_stage = '' AND letter <> 'a'")
    .all() as Array<{ analysis_id: string; letter: string }>;
  for (const fork of forks) {
    const events = database
      .prepare("SELECT detail_json FROM analysis_events WHERE analysis_id = ? AND kind = 'tracked_back' ORDER BY created_at")
      .all(fork.analysis_id) as Array<{ detail_json: string }>;
    for (const event of events) {
      try {
        const detail = JSON.parse(event.detail_json) as { newPath?: string; stage?: string };
        if (detail.newPath === fork.letter && detail.stage) {
          database
            .prepare('UPDATE analysis_paths SET parent_stage = ? WHERE analysis_id = ? AND letter = ?')
            .run(detail.stage, fork.analysis_id, fork.letter);
          break;
        }
      } catch {
        // a malformed detail row simply leaves the fork without a stage
      }
    }
  }
}

/**
 * Give the items written before extractions existed a header row to belong to. They are
 * filed on path 'a' — every later path descends from it, so every path's lineage still
 * sees them — and marked approved when the analysis had been approved, which is what the
 * approval meant at the time.
 */
function backfillExtractions(database: DatabaseSync): void {
  const orphans = database
    .prepare("SELECT DISTINCT analysis_id FROM analysis_items WHERE extraction_id = ''")
    .all() as Array<{ analysis_id: string }>;
  for (const { analysis_id } of orphans) {
    const counts = database
      .prepare(
        `SELECT COALESCE(SUM(accepted), 0) AS accepted, COUNT(*) - COALESCE(SUM(accepted), 0) AS rejected,
                MIN(created_at) AS at
         FROM analysis_items WHERE analysis_id = ?`,
      )
      .get(analysis_id) as { accepted: number; rejected: number; at: number };
    const analysis = database
      .prepare('SELECT state, updated_at FROM analyses WHERE analysis_id = ?')
      .get(analysis_id) as { state: string; updated_at: number } | undefined;
    const extractionId = `ext_${analysis_id.slice(-12)}_1`;
    database
      .prepare(
        `INSERT OR IGNORE INTO analysis_extractions
           (extraction_id, analysis_id, path_letter, seq, origin, accepted_count, rejected_count, approved_at, created_at)
         VALUES (?, ?, 'a', 1, 'agent', ?, ?, ?, ?)`,
      )
      .run(
        extractionId,
        analysis_id,
        counts.accepted,
        counts.rejected,
        analysis?.state === 'aprovada' ? analysis.updated_at : null,
        counts.at || Date.now(),
      );
    database
      .prepare("UPDATE analysis_items SET extraction_id = ? WHERE analysis_id = ? AND extraction_id = ''")
      .run(extractionId, analysis_id);
  }
}

/**
 * Closing an analysis used to record a SECOND `email_approved` on top of the one the
 * approval itself had written, so the chat said "E-mail aprovado" twice and the history
 * graph ended with two identical cards. The second one is what closure means, so it is
 * rewritten as the `analysis_closed` event it should always have been.
 */
function collapseDuplicateApprovals(database: DatabaseSync): void {
  const analyses = database
    .prepare(
      `SELECT analysis_id FROM analysis_events WHERE kind = 'email_approved'
       GROUP BY analysis_id HAVING COUNT(*) > 1`,
    )
    .all() as Array<{ analysis_id: string }>;
  for (const { analysis_id } of analyses) {
    const rows = database
      .prepare(
        `SELECT event_id FROM analysis_events WHERE analysis_id = ? AND kind = 'email_approved'
         ORDER BY created_at, rowid`,
      )
      .all(analysis_id) as Array<{ event_id: string }>;
    // Keep the first as the approval; every later one becomes the closing.
    for (const row of rows.slice(1)) {
      database.prepare("UPDATE analysis_events SET kind = 'analysis_closed' WHERE event_id = ?").run(row.event_id);
    }
  }

  // Approving the PDF used to record an e-mail EDIT as a side effect of persisting the
  // proposed draft, so the chat claimed the user had edited a message they had not opened.
  // Those are the ones written in the same second as the draft's creation.
  database
    .prepare(
      `DELETE FROM analysis_events WHERE kind = 'email_draft_edited' AND EXISTS (
         SELECT 1 FROM analysis_events c
         WHERE c.analysis_id = analysis_events.analysis_id AND c.kind = 'email_draft_created'
           AND ABS(c.created_at - analysis_events.created_at) < 2000
       )`,
    )
    .run();
}

function seedBootstrapAdmin(database: DatabaseSync): void {
  const email = String(process.env.LEGAL_BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.LEGAL_BOOTSTRAP_ADMIN_PASSWORD || '');
  if (!email || !password) return;

  const count = database.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (count.n > 0) return;

  const now = Date.now();
  database
    .prepare(
      `INSERT INTO users (user_id, email, name, role, password_hash, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', ?, 1, ?, ?)`,
    )
    .run(genId('usr'), email, 'Legal Assistant Admin', hashPassword(password), now, now);
  console.info(`[legal] Seeded bootstrap admin: ${email}`);
}

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(LEGAL_DATA_DIR, { recursive: true });
  mkdirSync(LEGAL_FILES_DIR, { recursive: true });
  const database = new DatabaseSync(LEGAL_DB_PATH);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(SCHEMA_SQL);
  // Classification metadata on documents (phase 2) — idempotent for pre-phase-2 DBs.
  migrateAddColumn(database, 'documents', 'doc_type', "doc_type TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'documents', 'title', "title TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'documents', 'subject', "subject TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'documents', 'issued_date', "issued_date TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'documents', 'effective_date', "effective_date TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'documents', 'language', "language TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'documents', 'topics_json', "topics_json TEXT NOT NULL DEFAULT '[]'");
  migrateAddColumn(database, 'documents', 'references_json', "references_json TEXT NOT NULL DEFAULT '[]'");
  migrateAddColumn(database, 'documents', 'classified_at', 'classified_at INTEGER NOT NULL DEFAULT 0');
  migrateAddColumn(database, 'documents', 'page_count', 'page_count INTEGER NOT NULL DEFAULT 0');
  // Classification breadth (briefing §8) + deterministic provenance columns.
  migrateAddColumn(database, 'documents', 'entity', "entity TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'documents', 'group_area', "group_area TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'documents', 'subtopics_json', "subtopics_json TEXT NOT NULL DEFAULT '[]'");
  migrateAddColumn(database, 'documents', 'version_label', "version_label TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'documents', 'extractor_version', "extractor_version TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'documents', 'ocr_quality', "ocr_quality TEXT NOT NULL DEFAULT ''");
  // The library takes any kind of document. Text extraction, pages and citations are all
  // defined on a PDF, so anything else is READ THROUGH a PDF rendition (converted by
  // Graph) stored beside the original — which stays the file the user uploaded.
  migrateAddColumn(database, 'documents', 'text_sha256', "text_sha256 TEXT NOT NULL DEFAULT ''");
  // Folders carry their own modified time, so the Library can show it in the same column as
  // a file's — OneDrive does, and "columns are what folders and files share".
  migrateAddColumn(database, 'drive_folders', 'drive_modified_at', 'drive_modified_at INTEGER NOT NULL DEFAULT 0');
  // The rest of §8's field list. `approval_status` is the document's own state — rascunho
  // or aprovado — which is a DIFFERENT axis from `state`, how far the app got reading it.
  // The briefing calls both "estado"; keeping them in separate columns with separate labels
  // is what stops that ambiguity becoming permanent.
  migrateAddColumn(database, 'documents', 'expiry_date', "expiry_date TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'documents', 'approval_status', "approval_status TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'documents', 'legislation_json', "legislation_json TEXT NOT NULL DEFAULT '[]'");
  migrateAddColumn(database, 'documents', 'obligations_json', "obligations_json TEXT NOT NULL DEFAULT '[]'");
  migrateAddColumn(database, 'documents', 'deadlines_json', "deadlines_json TEXT NOT NULL DEFAULT '[]'");
  // §7.5's structure, as a summary: how many headings, lists and tables the layout reader
  // found, and how much the table detector is willing to claim. Counts, not the structure
  // itself — the structure IS the page text, in Markdown.
  migrateAddColumn(database, 'documents', 'structure_json', "structure_json TEXT NOT NULL DEFAULT '{}'");
  // Which transcription prompt produced a cached OCR page. Without it, changing the prompt
  // would leave every existing page permanently served from a cache the new prompt never
  // wrote — silently, and forever.
  // The segment's vector, and the document's mean direction. Denormalised out of
  // embedding_cache so ranking is one table scan instead of a join per segment.
  migrateAddColumn(database, 'segments', 'embedding', 'embedding BLOB');
  // Recreated, not just created-if-absent: installs that predate the embedding column have
  // the trigger firing on ANY update to a segment, so writing a vector would re-tokenise the
  // whole FTS row. Narrowing it to the only column the index is built from is the fix.
  database.exec(`
    DROP TRIGGER IF EXISTS segments_fts_update;
    CREATE TRIGGER segments_fts_update AFTER UPDATE OF text ON segments BEGIN
      INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      INSERT INTO segments_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);
  migrateAddColumn(database, 'documents', 'centroid', 'centroid BLOB');
  // Whether this document's shortlist needs recomputing. Set by ingest, cleared by the
  // sweep — the queue drains once per sync, so a 500-file sync produces one pass, not 500.
  // §5.3's gate joins the analysis's related documents to the RELATION that put them
  // there. By id, deliberately, and not by the (from, to, type) triple: if the relations
  // engine re-runs and the AI picks a different type for the same pair, a triple join
  // silently starts showing the gate evidence for an edge that no longer exists.
  migrateAddColumn(database, 'analysis_documents', 'relation_id', "relation_id TEXT NOT NULL DEFAULT ''");
  // Which classification prompt produced this document's metadata and semantic profile.
  // Defaults to '1' — the version that predates the profile — so every existing document
  // is refreshed exactly once and none of them stays unindexable.
  migrateAddColumn(database, 'documents', 'classifier_version', "classifier_version TEXT NOT NULL DEFAULT '1'");
  // The subscription model's account of what the document is ABOUT, in normalised pt-PT
  // legal vocabulary — what makes "despedimento" retrieve a document that only ever says
  // "cessação do contrato de trabalho". Folded into the classification call, not a new one.
  migrateAddColumn(database, 'documents', 'semantic_profile_json', "semantic_profile_json TEXT NOT NULL DEFAULT '{}'");
  migrateAddColumn(database, 'ocr_cache', 'ocr_version', "ocr_version TEXT NOT NULL DEFAULT '1'");
  // §6's fine state. It rides BESIDE `state` rather than replacing it because SQLite cannot
  // ALTER a CHECK constraint and the coarse value is what a dozen server gates branch on.
  // `clientDocumentState()` combines the two into the one vocabulary the client uses.
  migrateAddColumn(database, 'documents', 'stage', "stage TEXT NOT NULL DEFAULT ''");
  // ONE column, not one flag per field: which metadata the user corrected by hand, so a
  // re-ingest can refresh everything else without clobbering their answer.
  migrateAddColumn(database, 'documents', 'metadata_overrides_json', "metadata_overrides_json TEXT NOT NULL DEFAULT '{}'");
  // A document can now come from INSIDE another one: an e-mail's attachments become
  // library documents of their own, linked back to the message they arrived in.
  migrateAddColumn(database, 'documents', 'parent_document_id', "parent_document_id TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'documents', 'source_kind', "source_kind TEXT NOT NULL DEFAULT ''");
  // The file is not reachable where the app last saw it — the library moved to another root
  // folder or another Microsoft account, and these rows were left behind. A FLAG beside
  // `removed`, never a `state` value: the CHECK vocabulary is frozen, and a missing file has
  // to KEEP its pipeline state so that nothing re-ingests when the file comes back.
  migrateAddColumn(database, 'documents', 'missing', 'missing INTEGER NOT NULL DEFAULT 0');
  migrateAddColumn(database, 'documents', 'missing_since', 'missing_since INTEGER NOT NULL DEFAULT 0');
  // The machine-readable half of an analysis's output, written beside the DOCX and PDF.
  migrateAddColumn(database, 'conversions', 'onedrive_json_id', "onedrive_json_id TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'conversions', 'json_sha256', "json_sha256 TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'conversions', 'json_filename', "json_filename TEXT NOT NULL DEFAULT ''");
  // A template can also be a .docx the client dropped into the library's Templates folder.
  // Those rows carry where they came from and whether they are actually fillable, so an
  // unusable one is offered with its reason instead of failing mid-generation.
  migrateAddColumn(database, 'templates', 'source', "source TEXT NOT NULL DEFAULT 'builtin'");
  migrateAddColumn(database, 'templates', 'document_id', "document_id TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'templates', 'valid', 'valid INTEGER NOT NULL DEFAULT 1');
  migrateAddColumn(database, 'templates', 'validation_error', "validation_error TEXT NOT NULL DEFAULT ''");
  // A workflow has a template per KIND: the Word document, and the e-mail that delivers it.
  // Everything registered before this column existed was the Word one.
  migrateAddColumn(database, 'templates', 'kind', "kind TEXT NOT NULL DEFAULT 'docx'");
  // The content fields an extraction was produced with, stored with it: the template may
  // change afterwards, and an approved extraction must keep reading as what it was.
  migrateAddColumn(database, 'analysis_extractions', 'fields_json', "fields_json TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'analysis_extractions', 'rejected_at', 'rejected_at INTEGER');
  migrateAddColumn(database, 'analysis_extractions', 'rejected_by', "rejected_by TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'analysis_extractions', 'rejection_reason', "rejection_reason TEXT NOT NULL DEFAULT ''");
  // Narrative sections persisted per version (phase 6) — what the revision chat edits.
  migrateAddColumn(database, 'analysis_versions', 'sections_json', "sections_json TEXT NOT NULL DEFAULT ''");
  // Fork model (phase 9): every existing version becomes path "a" with its own number.
  migrateAddColumn(database, 'analysis_versions', 'path_letter', "path_letter TEXT NOT NULL DEFAULT 'a'");
  migrateAddColumn(database, 'analysis_versions', 'path_seq', 'path_seq INTEGER NOT NULL DEFAULT 0');
  database.exec('UPDATE analysis_versions SET path_seq = version_no WHERE path_seq = 0');
  migrateAddColumn(database, 'analyses', 'active_path', "active_path TEXT NOT NULL DEFAULT 'a'");
  // Wizard fields (phase 9.1): optional guidance + template override chosen at setup.
  migrateAddColumn(database, 'analyses', 'instructions', "instructions TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'analyses', 'template_override', "template_override TEXT NOT NULL DEFAULT ''");
  // The e-mail draft the user sees and edits in-app before downloading it (phase 9.3).
  migrateAddColumn(database, 'analyses', 'email_draft_json', "email_draft_json TEXT NOT NULL DEFAULT ''");
  // An analysis closes when the e-mail is approved. It stays readable and its history
  // stays intact; the only thing that reopens it is reverting to an earlier phase.
  migrateAddColumn(database, 'analyses', 'closed_at', 'closed_at INTEGER');
  // What the agent is doing right now. Generating a document does not change the analysis
  // state, so without this the UI had no way to know it was happening: the phase said
  // "I am writing the document" while the gate offered to start writing it again.
  migrateAddColumn(database, 'analyses', 'busy_action', "busy_action TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'analyses', 'busy_started_at', 'busy_started_at INTEGER NOT NULL DEFAULT 0');
  database.exec(`INSERT OR IGNORE INTO analysis_paths (analysis_id, letter, parent_version_id, created_at)
                 SELECT DISTINCT analysis_id, 'a', '', created_at FROM analyses`);
  // Every event and turn belongs to a PATH. Inferring that from timestamps at read time
  // was wrong whenever the user switched paths, so it is stamped at write time; the rows
  // written before this migration are backfilled once, with the rule the reader used.
  migrateAddColumn(database, 'analysis_events', 'path_letter', "path_letter TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(database, 'analysis_turns', 'path_letter', "path_letter TEXT NOT NULL DEFAULT ''");
  // A fork also remembers the STAGE it restarted from — not just the version it hung off,
  // which is what made the graph draw the branch from the wrong node.
  migrateAddColumn(database, 'analysis_paths', 'parent_stage', "parent_stage TEXT NOT NULL DEFAULT ''");
  // A revert's answer belongs to the path it created, not to the analysis. Kept on the
  // analysis, it accumulated across every path: an instruction given while reworking path
  // B was then applied to path A the next time A was re-run.
  migrateAddColumn(database, 'analysis_paths', 'guidance', "guidance TEXT NOT NULL DEFAULT ''");
  backfillPathStamps(database);
  // Items belong to the extraction that produced them.
  migrateAddColumn(database, 'analysis_items', 'extraction_id', "extraction_id TEXT NOT NULL DEFAULT ''");
  backfillExtractions(database);
  collapseDuplicateApprovals(database);
  seedBootstrapAdmin(database);
  // Stamped once per process. An operation whose analysis was last touched before this
  // moment and is still "working" was killed by a restart — known dead, not merely slow,
  // so the UI can say so instead of polling a corpse forever.
  const bootedAt = String(Date.now());
  database
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('boot_epoch', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(bootedAt, Date.now());
  // `fold(text)` in SQL is the SAME folding the client uses, so a filter typed in the
  // browser and a filter run in SQLite agree about what "the same word" means. Without it
  // an accent-insensitive search would need a second, denormalised column kept in step by
  // every writer — this is one line and cannot drift.
  database.function('fold', { deterministic: true }, (value: unknown) => foldPt(String(value ?? '')));

  db = database;
  // After the schema is ready: upgrade any plaintext secret rows to encrypted form.
  migrateEncryptSecrets();
  return db;
}

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, Date.now());
}

export function deleteSetting(key: string): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
}

/** Drop every setting whose key starts with `prefix` — used to invalidate cached Graph ids. */
export function deleteSettingsWithPrefix(prefix: string): void {
  getDb()
    .prepare("DELETE FROM settings WHERE key LIKE ? ESCAPE '\\'")
    .run(`${prefix.replace(/[%_\\]/g, '\\$&')}%`);
}
