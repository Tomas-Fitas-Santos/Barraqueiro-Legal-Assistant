import { ApiError } from '@/app/api/_helpers';
import { buildReferenceList } from '@/lib/server/docx';
import { getAnalysis, listAnalysisDocuments } from '@/lib/server/repo/analyses';
import { currentExtraction, extractionItems } from '@/lib/server/repo/extractions';
import { listTemplates } from '@/lib/server/repo/templates';
import type { VersionRow } from '@/lib/server/repo/versions';
import { lineageOrder } from '@/lib/server/workflow';
import { ANALYSIS_TYPE_LABELS } from '@/lib/types';

// The machine-readable half of what an analysis produced.
//
// The DOCX and the PDF are what a person reads; this is the same work in a form that can be
// re-read, diffed or fed to something else — every extracted statement with its §10 fields,
// its citation, and whether it was accepted or rejected AND WHY. The rejections matter as
// much as the acceptances: they are the record of what the app refused to assert.
//
// It is written beside the DOCX and PDF, at conversion time, so the analysis folder always
// holds a coherent set of three files describing the same version.

export const ANALYSIS_EXPORT_SCHEMA = 'legal-assistant/analysis-export@1';

export type AnalysisExport = {
  schema: string;
  generatedAt: number;
  analysis: {
    analysisId: string;
    type: string;
    typeLabel: string;
    state: string;
    instructions: string;
    closedAt: number | null;
    createdAt: number;
  };
  mainDocument: { documentId: string; name: string } | null;
  relatedDocuments: Array<{
    documentId: string;
    name: string;
    relationType: string;
    status: string;
  }>;
  template: { templateId: string; version: number; name: string; source: string } | null;
  extraction: {
    extractionId: string;
    label: string;
    pathLetter: string;
    origin: string;
    acceptedCount: number;
    rejectedCount: number;
    approvedAt: number | null;
    approvedBy: string;
    note: string;
    fields: Array<{ key: string; label: string }>;
  } | null;
  items: Array<{
    itemId: string;
    seq: number;
    kind: string;
    payload: Record<string, unknown>;
    accepted: boolean;
    rejectionReason: string;
    decision: string;
  }>;
  references: Array<{ n: number; documentId: string; document: string; version: string; page: number; excerpt: string }>;
  version: {
    versionId: string;
    label: string;
    filename: string;
    origin: string;
    sha256: string;
    templateId: string;
    templateVersion: number;
    createdAt: number;
  };
  outputs: { docx: string; pdf: string; json: string };
};

export function analysisExportFilename(version: VersionRow): string {
  return `${version.filename.replace(/\.docx$/i, '')}_dados.json`;
}

export function buildAnalysisExport(
  version: VersionRow,
  outputs: { docx: string; pdf: string },
): AnalysisExport {
  const analysisId = version.analysisId;
  const analysis = getAnalysis(analysisId);
  if (!analysis) throw new ApiError('Analysis not found.', 404);
  const documents = listAnalysisDocuments(analysisId);
  const main = documents.find((doc) => doc.role === 'main') || null;

  // The extraction of the PATH this version belongs to — not simply the newest one, which
  // may live on a branch this document was never generated from.
  const extraction = currentExtraction(analysisId, lineageOrder(analysisId, version.pathLetter));
  const items = extraction ? extractionItems(extraction.extractionId) : [];

  const template =
    listTemplates().find(
      (tpl) => tpl.templateId === version.templateId && tpl.version === version.templateVersion,
    ) || null;

  const jsonFilename = analysisExportFilename(version);
  return {
    schema: ANALYSIS_EXPORT_SCHEMA,
    generatedAt: Date.now(),
    analysis: {
      analysisId,
      type: analysis.type,
      typeLabel: ANALYSIS_TYPE_LABELS[analysis.type],
      state: analysis.state,
      instructions: analysis.instructions,
      closedAt: analysis.closedAt,
      createdAt: analysis.createdAt,
    },
    mainDocument: main ? { documentId: main.documentId, name: main.documentName } : null,
    relatedDocuments: documents
      .filter((doc) => doc.role === 'related')
      .map((doc) => ({
        documentId: doc.documentId,
        name: doc.documentName,
        relationType: doc.relationType,
        status: doc.status,
      })),
    template: template
      ? {
          templateId: template.templateId,
          version: template.version,
          name: template.name,
          source: template.source,
        }
      : null,
    extraction: extraction
      ? {
          extractionId: extraction.extractionId,
          label: extraction.label,
          pathLetter: extraction.pathLetter,
          origin: extraction.origin,
          acceptedCount: extraction.acceptedCount,
          rejectedCount: extraction.rejectedCount,
          approvedAt: extraction.approvedAt,
          approvedBy: extraction.approvedBy,
          note: extraction.note,
          // The fields it was produced with, so the export reads as what it was even after
          // the extraction template changes.
          fields: extraction.fields.map((f) => ({ key: f.key, label: f.label })),
        }
      : null,
    items: items.map((item) => ({
      itemId: item.itemId,
      seq: item.seq,
      kind: item.kind,
      payload: item.payload,
      accepted: item.accepted,
      rejectionReason: item.rejectionReason,
      decision: item.decision,
    })),
    // The same list the document's "Anexo de fontes" shows — derived once, not twice.
    references: buildReferenceList(
      items
        .filter((item) => item.accepted)
        .map((item) => ({ payload: item.payload })) as Parameters<typeof buildReferenceList>[0],
    ),
    version: {
      versionId: version.versionId,
      label: version.label,
      filename: version.filename,
      origin: version.origin,
      sha256: version.sha256,
      templateId: version.templateId,
      templateVersion: version.templateVersion,
      createdAt: version.createdAt,
    },
    outputs: { ...outputs, json: jsonFilename },
  };
}
