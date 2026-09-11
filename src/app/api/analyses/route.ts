import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { createAnalysis, listAnalyses } from '@/lib/server/repo/analyses';
import { activeTemplateFor } from '@/lib/server/repo/templates';
import { workflowStatus } from '@/lib/server/workflow';
import { ANALYSIS_TYPES, type AnalysisType } from '@/lib/types';

export async function GET() {
  return withSession(async () => {
    const rows = listAnalyses();
    const analyses = await Promise.all(
      rows.map(async (row) => ({ ...row, nextTask: (await workflowStatus(row.analysisId)).nextTask })),
    );
    return NextResponse.json({ ok: true, analyses });
  });
}

export async function POST(req: Request) {
  return withSession(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const type = String(body.type || '') as AnalysisType;
    if (!ANALYSIS_TYPES.includes(type)) {
      return NextResponse.json({ ok: false, error: "type must be 'summary' or 'revision'." }, { status: 400 });
    }
    // Resolve the chosen template NOW: an unfillable one must be refused here, not
    // discovered when the document is generated at the end of the analysis.
    const templateId = typeof body.templateId === 'string' ? body.templateId : '';
    if (templateId) activeTemplateFor(type, templateId);

    const analysis = createAnalysis(type, String(body.mainDocumentId || ''), {
      relatedDocumentIds: Array.isArray(body.relatedDocumentIds)
        ? body.relatedDocumentIds.map((id) => String(id))
        : [],
      templateId,
      instructions: typeof body.instructions === 'string' ? body.instructions : '',
    });
    return NextResponse.json({ ok: true, analysis });
  });
}
