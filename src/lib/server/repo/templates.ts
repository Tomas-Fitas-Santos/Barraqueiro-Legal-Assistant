import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ApiError } from '@/app/api/_helpers';
import { analysisTypeForTemplatePath, templateFolderPath } from '@/lib/library-layout';
import { getDb } from '@/lib/server/db';
import { readLibraryItem, uploadToLibrary } from '@/lib/server/graph-files';
import { downloadItem, isLibraryConfigured } from '@/lib/server/msgraph';
import { LEGAL_DATA_DIR } from '@/lib/server/paths';
import {
  analysisTypeOfExtractionTemplate,
  buildExtractionTemplateJson,
  extractionFields,
  extractionTemplateSha,
  isExtractionEdited,
} from '@/lib/server/repo/extraction-template';
import {
  buildEmailTemplateEml,
  builtinTemplateSha,
  EMAIL_TEMPLATE_FIELDS,
  emailTemplateSha,
  isEdited,
  isEmailEdited,
  renderBuiltinTemplate,
} from '@/lib/server/repo/template-blocks';
import { validateTemplateBytes } from '@/lib/server/template-validate';
import type { AnalysisType } from '@/lib/types';

// The Word template registry (briefing §12). A built-in template is a BLOCK LIST
// (repo/template-blocks.ts) that the app renders to .docx on demand; the registry versions
// the result: at boot, a rendering whose hash differs from the active row becomes a NEW
// version. So an edit to the blocks, or a new letterhead, mints a version by the same route
// a replaced file used to. Documents already generated store the template_id+version+sha
// they used — a template change never touches them.

const TEMPLATE_FILES: Array<{
  templateId: string;
  /** The name the published copy carries in the library; the bytes are rendered, not read. */
  file: string;
  name: string;
  analysisType: 'summary' | 'revision';
  requiredFields: string[];
  fillRules: string;
}> = [
  {
    templateId: 'nota_resumo',
    file: 'nota-resumo.docx',
    name: 'Nota informativa / Resumo',
    analysisType: 'summary',
    requiredFields: ['doc_title', 'subtitle', 'main_document', 'date', 'sections', 'references'],
    fillRules: 'Sections from the validated statements; Anexo de fontes lists every cited source.',
  },
  {
    templateId: 'relatorio_revisao',
    file: 'relatorio-revisao.docx',
    name: 'Relatório de revisão / atualização',
    analysisType: 'revision',
    requiredFields: ['doc_title', 'subtitle', 'main_document', 'date', 'lines', 'sections', 'references'],
    fillRules: 'Matrix from the reviewed lines (user decisions shown); sections + Anexo as in the summary.',
  },
];

/**
 * The e-mail that delivers each Word document. Same registry, same versioning, different
 * kind: the bytes are a `.eml` rendered from a subject and a body, published beside the
 * Word template in the workflow's Templates folder.
 */
const EMAIL_TEMPLATE_FILES: Array<{
  templateId: string;
  file: string;
  name: string;
  analysisType: 'summary' | 'revision';
}> = [
  {
    templateId: 'email_resumo',
    file: 'email-resumo.eml',
    name: 'E-mail — Nota informativa / Resumo',
    analysisType: 'summary',
  },
  {
    templateId: 'email_revisao',
    file: 'email-revisao.eml',
    name: 'E-mail — Relatório de revisão / atualização',
    analysisType: 'revision',
  },
];

/**
 * The third kind: what the agent is asked to EXTRACT. Not a stencil for a file but the field
 * list itself, published as the `.json` it describes so the client can read the contract the
 * agent works to.
 */
const EXTRACTION_TEMPLATE_FILES: Array<{
  templateId: string;
  file: string;
  name: string;
  analysisType: 'summary' | 'revision';
}> = [
  {
    templateId: 'dados_resumo',
    file: 'dados-resumo.json',
    name: 'Dados extraídos — Nota informativa / Resumo',
    analysisType: 'summary',
  },
  {
    templateId: 'dados_revisao',
    file: 'dados-revisao.json',
    name: 'Dados extraídos — Relatório de revisão / atualização',
    analysisType: 'revision',
  },
];

export function extractionTemplateName(templateId: string): string {
  return EXTRACTION_TEMPLATE_FILES.find((d) => d.templateId === templateId)?.name || templateId;
}

export function extractionTemplateIdForFilename(filename: string): string {
  return EXTRACTION_TEMPLATE_FILES.find((d) => d.file.toLowerCase() === filename.toLowerCase())?.templateId || '';
}

export function emailTemplateIdFor(analysisType: AnalysisType): string {
  return EMAIL_TEMPLATE_FILES.find((d) => d.analysisType === analysisType)?.templateId || 'email_resumo';
}

export function emailTemplateName(templateId: string): string {
  return EMAIL_TEMPLATE_FILES.find((d) => d.templateId === templateId)?.name || templateId;
}

/** The e-mail template a published `.eml` in the library came from, matched on its name. */
export function emailTemplateIdForFilename(filename: string): string {
  return EMAIL_TEMPLATE_FILES.find((d) => d.file.toLowerCase() === filename.toLowerCase())?.templateId || '';
}


export type TemplateRow = {
  templateId: string;
  version: number;
  name: string;
  analysisType: 'summary' | 'revision';
  fileSha256: string;
  active: boolean;
  /** 'builtin' ships with the app; 'library' is a .docx the client put in the library. */
  source: 'builtin' | 'library';
  /** The library document a 'library' template came from. */
  documentId: string;
  /** Whether the app can actually fill it. An invalid template is offered, but refused. */
  valid: boolean;
  validationError: string;
  /** What the template produces: the Word document, or the e-mail that delivers it. */
  kind: 'docx' | 'eml' | 'json';
};

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const EML_MIME = 'message/rfc822';
const JSON_MIME = 'application/json';

/**
 * Where a library template's bytes live, content-addressed by the sha the registry already
 * stores. Template files are never ingested (a stencil is not a document), so
 * `documents.sha256` is never stamped for them — and rendering is synchronous, so the bytes
 * have to be on disk before anyone asks for them.
 */
const TEMPLATE_BYTES_DIR = path.join(LEGAL_DATA_DIR, 'files', 'templates');

function templateBytesPath(sha256: string): string {
  return path.join(TEMPLATE_BYTES_DIR, sha256);
}

/** The placeholders a built-in must keep to remain fillable, by template. */
export function requiredFieldsOf(templateId: string): string[] {
  return TEMPLATE_FILES.find((d) => d.templateId === templateId)?.requiredFields || [];
}

/** The built-in a published library copy came from, matched on the name it is published as. */
export function builtinTemplateIdForFilename(filename: string): string {
  return TEMPLATE_FILES.find((d) => d.file.toLowerCase() === filename.toLowerCase())?.templateId || '';
}

/** The editable template behind a published library file, whichever of the three kinds it is. */
export function editableTemplateIdForFilename(filename: string): string {
  return (
    builtinTemplateIdForFilename(filename) ||
    emailTemplateIdForFilename(filename) ||
    extractionTemplateIdForFilename(filename)
  );
}

/**
 * Whether the client has changed the template a published library file stands for.
 *
 * Dispatched on the same three resolvers as `editableTemplateIdForFilename`, because the
 * three kinds keep their edit in three different settings keys and the template id alone
 * does not say which family it belongs to.
 */
export function isTemplateEditedForFilename(filename: string): boolean {
  if (builtinTemplateIdForFilename(filename)) return isEdited(builtinTemplateIdForFilename(filename));
  if (emailTemplateIdForFilename(filename)) return isEmailEdited(emailTemplateIdForFilename(filename));
  const type = analysisTypeOfExtractionTemplate(extractionTemplateIdForFilename(filename));
  return type ? isExtractionEdited(type) : false;
}

export function builtinTemplateName(templateId: string): string {
  return TEMPLATE_FILES.find((d) => d.templateId === templateId)?.name || templateId;
}

/**
 * The library file a template is published as.
 *
 * Resolved by NAME, not by content hash and not by `templates.document_id`. That column
 * only ever holds a value for a template that CAME from the library; a built-in is written
 * out to the Templates folder, and the published bytes are rendered rather than the stored
 * blob, so the two hashes are allowed to differ. Matching on the hash worked for four of
 * the six and silently reported the other two as unpublished.
 */
export function publishedTemplateDocumentId(templateId: string): string {
  const file =
    TEMPLATE_FILES.find((d) => d.templateId === templateId)?.file ||
    EMAIL_TEMPLATE_FILES.find((d) => d.templateId === templateId)?.file ||
    EXTRACTION_TEMPLATE_FILES.find((d) => d.templateId === templateId)?.file ||
    '';
  if (file) {
    const row = getDb()
      .prepare('SELECT document_id FROM documents WHERE removed = 0 AND lower(name) = ? LIMIT 1')
      .get(file.toLowerCase()) as { document_id: string } | undefined;
    return row?.document_id || '';
  }
  // A template the client added themselves IS a library file, and knows which one.
  const row = listTemplates().find((t) => t.templateId === templateId && t.active);
  return row?.documentId || '';
}

function storeTemplateBytes(bytes: Buffer): string {
  const sha = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(TEMPLATE_BYTES_DIR, { recursive: true });
  const target = templateBytesPath(sha);
  if (!existsSync(target)) writeFileSync(target, bytes);
  return sha;
}

/** A stable id for a library template: same file, same id, so an edit becomes a version. */
function libraryTemplateId(analysisType: AnalysisType, filename: string): string {
  const slug = filename
    .replace(/\.docx$/i, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return `lib_${analysisType}_${slug || 'template'}`;
}

/** Idempotent boot seed: unchanged file = no-op; changed file = new active version. */
export function seedTemplates(): void {
  const db = getDb();
  const now = Date.now();
  for (const def of TEMPLATE_FILES) {
    const sha = builtinTemplateSha(def.templateId);
    const active = db
      .prepare('SELECT version, file_sha256 FROM templates WHERE template_id = ? AND active = 1')
      .get(def.templateId) as { version: number; file_sha256: string } | undefined;
    if (active?.file_sha256 === sha) continue;
    if (active) {
      db.prepare('UPDATE templates SET active = 0 WHERE template_id = ? AND active = 1').run(def.templateId);
    }
    db.prepare(
      `INSERT INTO templates (template_id, version, name, analysis_type, file_sha256, active, required_fields_json, fill_rules, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      def.templateId,
      (active?.version || 0) + 1,
      def.name,
      def.analysisType,
      sha,
      JSON.stringify(def.requiredFields),
      def.fillRules,
      now,
    );
    console.info(`[legal] Template ${def.templateId} registered as v${(active?.version || 0) + 1}.`);
  }

  for (const def of EMAIL_TEMPLATE_FILES) {
    const sha = emailTemplateSha(def.templateId);
    const active = db
      .prepare('SELECT version, file_sha256 FROM templates WHERE template_id = ? AND active = 1')
      .get(def.templateId) as { version: number; file_sha256: string } | undefined;
    if (active?.file_sha256 === sha) continue;
    if (active) {
      db.prepare('UPDATE templates SET active = 0 WHERE template_id = ? AND active = 1').run(def.templateId);
    }
    db.prepare(
      `INSERT INTO templates (template_id, version, name, analysis_type, file_sha256, active, required_fields_json, fill_rules, created_at, kind)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 'eml')`,
    ).run(
      def.templateId,
      (active?.version || 0) + 1,
      def.name,
      def.analysisType,
      sha,
      JSON.stringify(EMAIL_TEMPLATE_FIELDS),
      'Subject and body of the message that delivers the approved PDF.',
      now,
    );
    console.info(`[legal] E-mail template ${def.templateId} registered as v${(active?.version || 0) + 1}.`);
  }

  for (const def of EXTRACTION_TEMPLATE_FILES) {
    const sha = extractionTemplateSha(def.analysisType);
    const active = db
      .prepare('SELECT version, file_sha256 FROM templates WHERE template_id = ? AND active = 1')
      .get(def.templateId) as { version: number; file_sha256: string } | undefined;
    if (active?.file_sha256 === sha) continue;
    if (active) {
      db.prepare('UPDATE templates SET active = 0 WHERE template_id = ? AND active = 1').run(def.templateId);
    }
    db.prepare(
      `INSERT INTO templates (template_id, version, name, analysis_type, file_sha256, active, required_fields_json, fill_rules, created_at, kind)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 'json')`,
    ).run(
      def.templateId,
      (active?.version || 0) + 1,
      def.name,
      def.analysisType,
      sha,
      JSON.stringify(extractionFields(def.analysisType).map((f) => f.key)),
      'The content fields the agent extracts. The citation spine is fixed by §11.',
      now,
    );
    console.info(`[legal] Extraction template ${def.templateId} registered as v${(active?.version || 0) + 1}.`);
  }
}

export function listTemplates(): TemplateRow[] {
  seedTemplates();
  const rows = getDb()
    .prepare('SELECT * FROM templates ORDER BY template_id, version DESC')
    .all() as Array<{
    template_id: string;
    version: number;
    name: string;
    analysis_type: 'summary' | 'revision';
    file_sha256: string;
    active: number;
    source: string;
    document_id: string;
    valid: number;
    validation_error: string;
    kind: string;
  }>;
  return rows.map((row) => ({
    templateId: row.template_id,
    version: row.version,
    name: row.name,
    analysisType: row.analysis_type,
    fileSha256: row.file_sha256,
    active: Boolean(row.active),
    source: row.source === 'library' ? 'library' : 'builtin',
    documentId: row.document_id || '',
    valid: Boolean(row.valid),
    validationError: row.validation_error || '',
    kind: row.kind === 'eml' ? 'eml' : row.kind === 'json' ? 'json' : 'docx',
  }));
}

/** The bytes of a registered template, wherever that template came from. */
function templateBytes(row: TemplateRow): Buffer {
  if (row.source === 'library') {
    const target = templateBytesPath(row.fileSha256);
    if (!existsSync(target)) {
      throw new ApiError('O template escolhido já não está disponível na biblioteca.', 400);
    }
    return readFileSync(target);
  }
  return renderBuiltinTemplate(row.templateId);
}

export function activeTemplateFor(
  analysisType: 'summary' | 'revision',
  overrideTemplateId?: string,
): TemplateRow & { bytes: Buffer } {
  seedTemplates();
  const all = listTemplates();
  if (overrideTemplateId) {
    const chosen = all.find((tpl) => tpl.active && tpl.kind === 'docx' && tpl.templateId === overrideTemplateId);
    if (!chosen) throw new ApiError('O template escolhido já não está disponível.', 400);
    // Falling back to the default here would silently produce a document in a format
    // nobody asked for — worse than saying the chosen template cannot be used.
    if (!chosen.valid) {
      throw new ApiError(chosen.validationError || 'O template escolhido não pode ser preenchido.', 400);
    }
    return { ...chosen, bytes: templateBytes(chosen) };
  }
  // With no explicit choice the DEFAULT is always the app's own template. Library rows sort
  // ahead of the built-ins by id ('lib_…' < 'nota_resumo'), so without this a file dropped
  // into the library would quietly become the format of every new analysis.
  const row = all.find(
    (tpl) => tpl.active && tpl.kind === 'docx' && tpl.source === 'builtin' && tpl.analysisType === analysisType,
  );
  if (!row) throw new ApiError(`No active template for ${analysisType} analyses.`, 500);
  return { ...row, bytes: templateBytes(row) };
}

/**
 * Publish the app's own templates into the library so the client can see the format their
 * documents are produced in — and start from it when they want their own.
 *
 * This used to check only whether a file was already there, and skip if it was. The effect
 * was that a built-in template could never be corrected after its first publish: the
 * letterhead went into the repo and the copies on the client's OneDrive stayed as they
 * were. So the decision is made on CONTENT instead:
 *
 *   - nothing at that path      -> upload it
 *   - already the current bytes -> nothing to do
 *   - bytes we published before -> replace in place (this is our file, untouched)
 *   - anything else             -> leave it alone, the client has edited it
 *
 * `replace` is safe only because of that third case; `rename` is not used here because it
 * would leave a "nota-resumo 1.docx" behind on every run.
 */
export async function publishBuiltinTemplates(): Promise<void> {
  if (!isLibraryConfigured() && process.env.LEGAL_FAKE_GRAPH !== '1') return;
  const db = getDb();
  seedTemplates();
  // Every version of a built-in the app has ever registered, current and past. A library
  // file whose hash is in here is a published copy nobody has touched since.
  const published = new Set(
    (db.prepare("SELECT file_sha256 FROM templates WHERE source = 'builtin'").all() as Array<{
      file_sha256: string;
    }>).map((r) => r.file_sha256),
  );
  for (const def of TEMPLATE_FILES) {
    const bytes = renderBuiltinTemplate(def.templateId);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const folder = templateFolderPath(def.analysisType);
    try {
      const current = await readLibraryItem(`${folder}/${def.file}`);
      if (!current) {
        await uploadToLibrary(def.file, bytes, folder, DOCX_MIME);
        continue;
      }
      const currentSha = createHash('sha256').update(current).digest('hex');
      if (currentSha === sha || !published.has(currentSha)) continue;
      await uploadToLibrary(def.file, bytes, folder, DOCX_MIME, 'replace');
    } catch (error) {
      console.warn(
        `[legal] Could not publish the template ${def.file}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  for (const def of EMAIL_TEMPLATE_FILES) {
    const bytes = buildEmailTemplateEml(def.templateId);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const folder = templateFolderPath(def.analysisType);
    try {
      const current = await readLibraryItem(`${folder}/${def.file}`);
      if (!current) {
        await uploadToLibrary(def.file, bytes, folder, EML_MIME);
        continue;
      }
      const currentSha = createHash('sha256').update(current).digest('hex');
      if (currentSha === sha || !published.has(currentSha)) continue;
      await uploadToLibrary(def.file, bytes, folder, EML_MIME, 'replace');
    } catch (error) {
      console.warn(
        `[legal] Could not publish the e-mail template ${def.file}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  for (const def of EXTRACTION_TEMPLATE_FILES) {
    const bytes = buildExtractionTemplateJson(def.analysisType);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const folder = templateFolderPath(def.analysisType);
    try {
      const current = await readLibraryItem(`${folder}/${def.file}`);
      if (!current) {
        await uploadToLibrary(def.file, bytes, folder, JSON_MIME);
        continue;
      }
      const currentSha = createHash('sha256').update(current).digest('hex');
      if (currentSha === sha || !published.has(currentSha)) continue;
      await uploadToLibrary(def.file, bytes, folder, JSON_MIME, 'replace');
    } catch (error) {
      console.warn(
        `[legal] Could not publish the extraction template ${def.file}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/**
 * Register every .docx sitting in the library's Templates folders, so the client can supply
 * their own format without a deploy. Each file is validated as it is picked up; an
 * unusable one is registered as invalid, with the reason, rather than being hidden.
 */
export async function refreshLibraryTemplates(): Promise<void> {
  const db = getDb();
  seedTemplates();
  const builtinShas = new Set(
    (db.prepare("SELECT file_sha256 FROM templates WHERE source = 'builtin'").all() as Array<{
      file_sha256: string;
    }>).map((r) => r.file_sha256),
  );
  const docs = db
    .prepare(
      `SELECT document_id, drive_item_id, name, path, sha256 FROM documents
       WHERE removed = 0 AND lower(name) LIKE '%.docx'`,
    )
    .all() as Array<{ document_id: string; drive_item_id: string; name: string; path: string; sha256: string }>;

  const seen = new Set<string>();
  for (const doc of docs) {
    const analysisType = analysisTypeForTemplatePath(doc.path);
    if (!analysisType) continue;
    const def = TEMPLATE_FILES.find((d) => d.analysisType === analysisType);
    const requiredFields = def ? def.requiredFields : [];

    let bytes: Buffer;
    try {
      bytes = await readTemplateSource(doc.drive_item_id, doc.sha256);
    } catch (error) {
      console.warn(
        `[legal] Could not read the library template ${doc.name}:`,
        error instanceof Error ? error.message : error,
      );
      continue;
    }
    const sha = storeTemplateBytes(bytes);
    // The published built-ins live in these folders too. Identified by CONTENT, so a copy
    // under any name is still recognised as the app's own template, not a second one.
    if (builtinShas.has(sha)) continue;

    const templateId = libraryTemplateId(analysisType, doc.name);
    seen.add(templateId);
    const active = db
      .prepare('SELECT version, file_sha256 FROM templates WHERE template_id = ? AND active = 1')
      .get(templateId) as { version: number; file_sha256: string } | undefined;
    if (active?.file_sha256 === sha) continue;

    const check = validateTemplateBytes(bytes, requiredFields);
    if (active) db.prepare('UPDATE templates SET active = 0 WHERE template_id = ? AND active = 1').run(templateId);
    db.prepare(
      `INSERT INTO templates (template_id, version, name, analysis_type, file_sha256, active,
                              required_fields_json, fill_rules, created_at, source, document_id, valid, validation_error)
       VALUES (?, ?, ?, ?, ?, 1, ?, '', ?, 'library', ?, ?, ?)`,
    ).run(
      templateId,
      (active?.version || 0) + 1,
      doc.name.replace(/\.docx$/i, ''),
      analysisType,
      sha,
      JSON.stringify(requiredFields),
      Date.now(),
      doc.document_id,
      check.valid ? 1 : 0,
      check.valid ? '' : check.error,
    );
  }

  // A template whose file left the folder stops being offered; its rows stay, so documents
  // already generated with it keep saying which template they used.
  const stale = db
    .prepare("SELECT template_id FROM templates WHERE source = 'library' AND active = 1")
    .all() as Array<{ template_id: string }>;
  for (const row of stale) {
    if (!seen.has(row.template_id)) {
      db.prepare('UPDATE templates SET active = 0 WHERE template_id = ? AND active = 1').run(row.template_id);
    }
  }
}

/** Template bytes come from the local original when there is one, otherwise from OneDrive. */
async function readTemplateSource(driveItemId: string, sha256: string): Promise<Buffer> {
  if (sha256) {
    const { originalPath } = await import('@/lib/server/ingest/pipeline');
    const local = originalPath(sha256);
    if (existsSync(local)) return readFileSync(local);
  }
  if (process.env.LEGAL_FAKE_GRAPH === '1' || driveItemId.startsWith('local-')) {
    throw new ApiError('Template bytes are not available locally.', 404);
  }
  const res = await downloadItem(driveItemId);
  return Buffer.from(await res.arrayBuffer());
}

