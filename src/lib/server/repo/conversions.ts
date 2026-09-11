import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ApiError } from '@/app/api/_helpers';
import { generatedFolderPath } from '@/lib/library-layout';
import { genId } from '@/lib/server/crypto';
import { getDb } from '@/lib/server/db';
import { LEGAL_DATA_DIR } from '@/lib/server/paths';
import { analysisExportFilename, buildAnalysisExport } from '@/lib/server/repo/analysis-export';
import { convertItemToPdf, readPdfBytes, storePdfBytes, uploadGeneratedFile } from '@/lib/server/graph-files';
import { getAnalysis, recordEvent } from '@/lib/server/repo/analyses';
import { ANALYSIS_TYPE_LABELS } from '@/lib/types';
import { getVersion, readVersionBytes, type VersionRow } from '@/lib/server/repo/versions';

// The DOCX→PDF conversion chain (briefing §12/§16): save the final DOCX to OneDrive,
// convert via Graph, save the PDF to OneDrive, bind everything by hash. Conversion
// failure never touches the DOCX and never falls back to an older PDF; a superseded
// version's PDF is desatualizado forever.

/** The exported JSON, kept locally too so it can be downloaded without a round trip. */
const GENERATED_JSON_DIR = path.join(LEGAL_DATA_DIR, 'files', 'exports');

function storeGeneratedJson(bytes: Buffer): string {
  const sha = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(GENERATED_JSON_DIR, { recursive: true });
  const target = path.join(GENERATED_JSON_DIR, sha);
  if (!existsSync(target)) writeFileSync(target, bytes);
  return sha;
}

export function readGeneratedJson(sha256: string): Buffer {
  const target = path.join(GENERATED_JSON_DIR, sha256);
  if (!existsSync(target)) throw new ApiError('Os dados exportados já não estão disponíveis.', 404);
  return readFileSync(target);
}

export type ConversionState =
  | 'pendente'
  | 'em_conversao'
  | 'pronto_para_revisao'
  | 'aprovado_para_envio'
  | 'erro'
  | 'desatualizado';

export type ConversionRow = {
  conversionId: string;
  analysisId: string;
  versionId: string;
  docxSha256: string;
  onedriveDocxId: string;
  onedrivePdfId: string;
  pdfSha256: string;
  pdfFilename: string;
  pdfSize: number;
  pdfPages: number;
  /** The exported analysis data written beside the DOCX and PDF. Empty if it failed. */
  jsonFilename: string;
  jsonSha256: string;
  state: ConversionState;
  stateDetail: string;
  approvedBy: string;
  approvedAt: number | null;
  createdAt: number;
};

type DbConversionRow = {
  conversion_id: string;
  analysis_id: string;
  version_id: string;
  docx_sha256: string;
  onedrive_docx_id: string;
  onedrive_pdf_id: string;
  pdf_sha256: string;
  pdf_filename: string;
  pdf_size: number;
  pdf_pages: number;
  json_filename: string;
  json_sha256: string;
  state: ConversionState;
  state_detail: string;
  approved_by: string;
  approved_at: number | null;
  created_at: number;
};

function toRow(row: DbConversionRow): ConversionRow {
  return {
    conversionId: row.conversion_id,
    analysisId: row.analysis_id,
    versionId: row.version_id,
    docxSha256: row.docx_sha256,
    onedriveDocxId: row.onedrive_docx_id,
    onedrivePdfId: row.onedrive_pdf_id,
    pdfSha256: row.pdf_sha256,
    pdfFilename: row.pdf_filename,
    pdfSize: row.pdf_size,
    pdfPages: row.pdf_pages,
    jsonFilename: row.json_filename || '',
    jsonSha256: row.json_sha256 || '',
    state: row.state,
    stateDetail: row.state_detail,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
  };
}

export function listConversions(analysisId: string): ConversionRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM conversions WHERE analysis_id = ? ORDER BY created_at DESC')
    .all(analysisId) as DbConversionRow[];
  return rows.map(toRow);
}

export function getConversion(analysisId: string, conversionId: string): ConversionRow {
  const row = getDb()
    .prepare('SELECT * FROM conversions WHERE analysis_id = ? AND conversion_id = ?')
    .get(analysisId, conversionId) as DbConversionRow | undefined;
  if (!row) throw new ApiError('Conversion not found.', 404);
  return toRow(row);
}

function setConversionState(conversionId: string, state: ConversionState, detail = ''): void {
  getDb()
    .prepare('UPDATE conversions SET state = ?, state_detail = ?, updated_at = ? WHERE conversion_id = ?')
    .run(state, detail, Date.now(), conversionId);
}

/**
 * The folder an analysis's outputs live in: readable for a human browsing OneDrive, and
 * unique because it carries the analysis id (two revisions of the same document never
 * collide).
 */
export function analysisFolderName(analysisId: string): string {
  const analysis = getAnalysis(analysisId);
  const base = analysis
    ? `${ANALYSIS_TYPE_LABELS[analysis.type]} — ${analysis.mainDocumentName.replace(/\.pdf$/i, '')}`
    : 'Análise';
  const safe = base.replace(/[\\/:*?"<>|]/g, '-').slice(0, 90).trim();
  return `${safe} (${analysisId.slice(-6)})`;
}

export async function pdfPageCount(bytes: Buffer): Promise<number> {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  return pdf.numPages;
}

async function runConversion(conversionId: string, version: VersionRow): Promise<void> {
  const db = getDb();
  setConversionState(conversionId, 'em_conversao');
  try {
    const docxBytes = readVersionBytes(version);
    const analysis = getAnalysis(version.analysisId);
    if (!analysis) throw new ApiError('Analysis not found.', 404);
    // Outputs live under the generated-documents folder, split by workflow: browsing
    // OneDrive, a resumo and a revisão of the same document no longer sit side by side.
    const folder = `${generatedFolderPath(analysis.type)}/${analysisFolderName(version.analysisId)}`;
    // 1) Final DOCX to OneDrive, inside this analysis's own folder.
    const docxUpload = await uploadGeneratedFile(
      version.filename,
      docxBytes,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      folder,
    );
    // 2) Convert THAT item; 3) PDF back to OneDrive, name carrying the version (§14).
    const pdfBytes = await convertItemToPdf(docxUpload.itemId, docxBytes);
    const pdfFilename = `${version.filename.replace(/\.docx$/i, '')}_final.pdf`;
    const pdfUpload = await uploadGeneratedFile(pdfFilename, pdfBytes, 'application/pdf', folder);
    const stored = storePdfBytes(pdfBytes);
    const pages = await pdfPageCount(pdfBytes);
    if (pages <= 0) throw new ApiError('Converted PDF has no pages.', 502);

    db.prepare(
      `UPDATE conversions SET onedrive_docx_id = ?, onedrive_pdf_id = ?, pdf_sha256 = ?, pdf_filename = ?,
              pdf_size = ?, pdf_pages = ?, state = 'pronto_para_revisao', state_detail = '', updated_at = ?
       WHERE conversion_id = ?`,
    ).run(docxUpload.itemId, pdfUpload.itemId, stored.sha256, pdfFilename, pdfBytes.length, pages, Date.now(), conversionId);

    // 4) The same work as data, beside the two documents. In its own try/catch: the PDF is
    // what the client receives, and it must not be lost because an export failed.
    try {
      const exported = buildAnalysisExport(version, { docx: version.filename, pdf: pdfFilename });
      const jsonFilename = analysisExportFilename(version);
      const jsonBytes = Buffer.from(JSON.stringify(exported, null, 2), 'utf8');
      const jsonUpload = await uploadGeneratedFile(jsonFilename, jsonBytes, 'application/json', folder);
      const storedJson = storeGeneratedJson(jsonBytes);
      db.prepare(
        'UPDATE conversions SET onedrive_json_id = ?, json_sha256 = ?, json_filename = ?, updated_at = ? WHERE conversion_id = ?',
      ).run(jsonUpload.itemId, storedJson, jsonFilename, Date.now(), conversionId);
    } catch (error) {
      console.warn(
        `[legal] Could not export the analysis data for ${version.analysisId}:`,
        error instanceof Error ? error.message : error,
      );
    }
    recordEvent(version.analysisId, 'pdf_converted', {
      conversionId,
      versionNo: version.versionNo,
      pdfFilename,
      pdfPages: pages,
      pdfSha256: stored.sha256,
    });
  } catch (error) {
    // §16: no draft, no old-PDF fallback, DOCX untouched — just the honest error + retry.
    const message = error instanceof Error ? error.message : String(error);
    setConversionState(conversionId, 'erro', message.slice(0, 300));
    recordEvent(version.analysisId, 'pdf_conversion_failed', { conversionId, message: message.slice(0, 300) });
  }
}

/**
 * Set-final trigger (§12): create the conversion record and start the chain.
 *
 * The record is written and returned immediately, in state `pendente`, and the upload +
 * Graph conversion + upload runs after the response. Approving the document is a click,
 * not a reason to hold a request open for as long as OneDrive takes; the conversion
 * reports its own progress and its own failure, which is what the PDF phase reads.
 */
export function startConversionForFinal(analysisId: string, versionId: string): ConversionRow {
  const version = getVersion(analysisId, versionId);
  if (!version.isFinal) throw new ApiError('Only the final version is converted.', 409);
  const db = getDb();
  const conversionId = genId('cnv');
  const now = Date.now();
  db.prepare(
    `INSERT INTO conversions (conversion_id, analysis_id, version_id, docx_sha256, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pendente', ?, ?)`,
  ).run(conversionId, analysisId, versionId, version.sha256, now, now);

  // Fire-and-forget is safe here precisely because runConversion writes its own outcome:
  // success lands as `pronto_para_revisao`, failure as `erro` with the reason and a retry.
  void runConversion(conversionId, version).catch((error) => {
    console.error('[legal] Conversion chain crashed outside its own handler:', error);
  });
  return getConversion(analysisId, conversionId);
}

/** Run the conversion to completion — used where the caller needs the finished state. */
export async function convertNow(analysisId: string, versionId: string): Promise<ConversionRow> {
  const conversion = startConversionForFinal(analysisId, versionId);
  await runConversion(conversion.conversionId, getVersion(analysisId, versionId));
  return getConversion(analysisId, conversion.conversionId);
}

export async function retryConversion(analysisId: string, conversionId: string): Promise<ConversionRow> {
  const conversion = getConversion(analysisId, conversionId);
  if (conversion.state !== 'erro') throw new ApiError(`Only a failed conversion can be retried (state: ${conversion.state}).`, 409);
  const version = getVersion(analysisId, conversion.versionId);
  if (!version.isFinal) throw new ApiError('The source version is no longer the final one.', 409);
  await runConversion(conversionId, version);
  return getConversion(analysisId, conversionId);
}

/** Explicit human approval of the PDF (§12 step 6) — the last gate before email. */
export function approvePdf(analysisId: string, conversionId: string, approvedBy: string): ConversionRow {
  const conversion = getConversion(analysisId, conversionId);
  if (conversion.state !== 'pronto_para_revisao') {
    throw new ApiError(`Only a PDF "pronto_para_revisao" can be approved (state: ${conversion.state}).`, 409);
  }
  getDb()
    .prepare(
      `UPDATE conversions SET state = 'aprovado_para_envio', approved_by = ?, approved_at = ?, updated_at = ? WHERE conversion_id = ?`,
    )
    .run(approvedBy, Date.now(), Date.now(), conversionId);
  recordEvent(analysisId, 'pdf_approved', { conversionId, approvedBy });
  return getConversion(analysisId, conversionId);
}

export function readConversionPdf(analysisId: string, conversionId: string): { conversion: ConversionRow; bytes: Buffer } {
  const conversion = getConversion(analysisId, conversionId);
  if (!conversion.pdfSha256) throw new ApiError('This conversion has no PDF yet.', 409);
  return { conversion, bytes: readPdfBytes(conversion.pdfSha256) };
}

export function readConversionJson(
  analysisId: string,
  conversionId: string,
): { conversion: ConversionRow; bytes: Buffer } {
  const conversion = getConversion(analysisId, conversionId);
  if (!conversion.jsonSha256) throw new ApiError('Esta conversão ainda não tem dados exportados.', 409);
  return { conversion, bytes: readGeneratedJson(conversion.jsonSha256) };
}
