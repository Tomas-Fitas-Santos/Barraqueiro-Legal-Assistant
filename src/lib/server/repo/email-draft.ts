import { ApiError } from '@/app/api/_helpers';
import { getDb } from '@/lib/server/db';
import { readPdfBytes } from '@/lib/server/graph-files';
import { getAnalysis, recordEvent } from '@/lib/server/repo/analyses';
import { listConversions, type ConversionRow } from '@/lib/server/repo/conversions';
import { emailTemplate, fillEmailTemplate } from '@/lib/server/repo/template-blocks';
import { emailTemplateIdFor } from '@/lib/server/repo/templates';
import { listVersions } from '@/lib/server/repo/versions';
import { ANALYSIS_TYPE_LABELS } from '@/lib/types';

// The email draft (briefing §16). The triple gate, verbatim: a final DOCX version + a PDF
// generated FROM THAT version + explicit user approval of that PDF. The PDF is always the
// attachment; the DOCX never is. The app can only ever produce a DRAFT (.eml download in
// the MVP — Outlook Mail.ReadWrite is a later, separately-consented option); Mail.Send
// does not exist anywhere in this codebase.

export type DraftGate =
  | { allowed: true; conversion: ConversionRow; summary: DraftSummary }
  | { allowed: false; reason: string };

export type DraftSummary = {
  pdfName: string;
  pdfSize: number;
  pdfPages: number;
  docxVersionNo: number;
  conversionAt: number;
  approvalAt: number | null;
  approvedBy: string;
};

/** §16: the "Preparar e-mail" button state, with the honest reason when disabled. */
export function draftGate(analysisId: string): DraftGate {
  const analysis = getAnalysis(analysisId);
  if (!analysis || analysis.state === 'eliminada') throw new ApiError('Analysis not found.', 404);

  const finalVersion = listVersions(analysisId).find((v) => v.isFinal);
  if (!finalVersion) return { allowed: false, reason: 'Não existe uma versão final do DOCX.' };

  // The conversion must belong to the CURRENT final version — never an older PDF.
  const conversion = listConversions(analysisId).find((c) => c.versionId === finalVersion.versionId);
  if (!conversion) return { allowed: false, reason: 'A versão final ainda não foi convertida em PDF.' };
  if (conversion.docxSha256 !== finalVersion.sha256) {
    return { allowed: false, reason: 'O PDF não corresponde ao hash da versão final do DOCX.' };
  }
  switch (conversion.state) {
    case 'pendente':
    case 'em_conversao':
      return { allowed: false, reason: 'A conversão para PDF ainda está a decorrer.' };
    case 'erro':
      return { allowed: false, reason: `A conversão para PDF falhou: ${conversion.stateDetail}` };
    case 'desatualizado':
      return { allowed: false, reason: 'O PDF está desatualizado — foi criada uma versão mais recente do DOCX.' };
    case 'pronto_para_revisao':
      return { allowed: false, reason: 'O PDF ainda não foi aprovado pelo utilizador.' };
    case 'aprovado_para_envio':
      break;
  }

  return {
    allowed: true,
    conversion,
    summary: {
      pdfName: conversion.pdfFilename,
      pdfSize: conversion.pdfSize,
      pdfPages: conversion.pdfPages,
      docxVersionNo: finalVersion.versionNo,
      conversionAt: conversion.createdAt,
      approvalAt: conversion.approvedAt,
      approvedBy: conversion.approvedBy,
    },
  };
}

export type DraftContent = { to: string; cc: string; subject: string; body: string };

/** The saved draft, or the default the app proposes for this analysis. */
export function draftContent(analysisId: string): DraftContent {
  const analysis = getAnalysis(analysisId);
  if (!analysis) throw new ApiError('Analysis not found.', 404);
  const stored = String(
    (getDb().prepare('SELECT email_draft_json FROM analyses WHERE analysis_id = ?').get(analysisId) as {
      email_draft_json: string;
    }).email_draft_json || '',
  );
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Partial<DraftContent>;
      return {
        to: String(parsed.to || ''),
        cc: String(parsed.cc || ''),
        subject: String(parsed.subject || ''),
        body: String(parsed.body || ''),
      };
    } catch {
      // fall through to the proposal
    }
  }
  // The wording comes from the e-mail template for this workflow, which the client can edit
  // in the app and read in the library. It used to be written here, so changing a greeting
  // meant a deploy.
  const docName = analysis.mainDocumentName.replace(/\.pdf$/i, '');
  const finalVersion = listVersions(analysisId).find((v) => v.isFinal);
  const versionLabel = finalVersion ? finalVersion.label : '';
  const tpl = emailTemplate(emailTemplateIdFor(analysis.type));
  const filled = fillEmailTemplate(tpl || { subject: '', body: '' }, {
    analysis_type: ANALYSIS_TYPE_LABELS[analysis.type],
    main_document: docName,
    version: versionLabel ? `versão ${versionLabel} aprovada` : 'versão aprovada',
  });
  return { to: '', cc: '', subject: filled.subject, body: filled.body };
}

/**
 * Persist the draft. `silent` is for the agent PREPARING it on PDF approval: that is not an
 * edit by anyone, and recording one told the user "Editei o e-mail" about a message they
 * had never opened.
 */
export function saveDraftContent(
  analysisId: string,
  content: Partial<DraftContent>,
  options: { silent?: boolean } = {},
): DraftContent {
  const current = draftContent(analysisId);
  const next: DraftContent = {
    to: String(content.to ?? current.to).slice(0, 2000),
    cc: String(content.cc ?? current.cc).slice(0, 2000),
    subject: String(content.subject ?? current.subject).slice(0, 500),
    body: String(content.body ?? current.body).slice(0, 20000),
  };
  getDb()
    .prepare('UPDATE analyses SET email_draft_json = ?, updated_at = ? WHERE analysis_id = ?')
    .run(JSON.stringify(next), Date.now(), analysisId);
  if (!options.silent) recordEvent(analysisId, 'email_draft_edited', {});
  return next;
}

function encodeQuotedSubject(subject: string): string {
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

/**
 * Build the approved .eml draft bytes (RFC 5322 + MIME). This does not approve or close
 * anything: the single mandatory attachment is the approved PDF, and downloading is a
 * separate, repeatable action after the final human decision.
 */
export function buildEmlDraft(
  analysisId: string,
  options: { to?: string; cc?: string; subject?: string; body?: string },
): { filename: string; bytes: Buffer; summary: DraftSummary } {
  const gate = draftGate(analysisId);
  if (!gate.allowed) throw new ApiError(`Rascunho bloqueado: ${gate.reason}`, 409);
  const analysis = getAnalysis(analysisId);
  if (!analysis) throw new ApiError('Analysis not found.', 404);

  const pdfBytes = readPdfBytes(gate.conversion.pdfSha256);
  const boundary = `----legal-${gate.conversion.conversionId}`;
  // What the user actually sees and edits in the app IS what gets written.
  const content = draftContent(analysisId);
  const subject = String(options.subject || content.subject);
  const bodyLines = String(options.body || content.body).replace(/\n/g, '\r\n');

  const eml = [
    `To: ${String(options.to ?? content.to).trim()}`,
    `Cc: ${String(options.cc ?? content.cc).trim()}`,
    `Subject: ${encodeQuotedSubject(subject)}`,
    'X-Unsent: 1', // opens as a draft in mail clients
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    bodyLines,
    '',
    `--${boundary}`,
    'Content-Type: application/pdf',
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${gate.summary.pdfName}"`,
    '',
    pdfBytes.toString('base64').replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}--`,
    '',
  ].join('\r\n');

  return {
    filename: `${gate.summary.pdfName.replace(/\.pdf$/i, '')}.eml`,
    bytes: Buffer.from(eml, 'utf8'),
    summary: gate.summary,
  };
}
