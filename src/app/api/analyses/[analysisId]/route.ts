import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import {
  deleteAnalysis,
  getAnalysis,
  listAnalysisDocuments,
  listEvents,
  listItems,
} from '@/lib/server/repo/analyses';

export async function GET(_req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    await requireSession();
    const { analysisId } = await ctx.params;
    const analysis = getAnalysis(analysisId);
    if (!analysis || analysis.state === 'eliminada') {
      return NextResponse.json({ ok: false, error: 'Analysis not found.' }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      analysis,
      documents: listAnalysisDocuments(analysisId),
      items: listItems(analysisId),
      events: listEvents(analysisId),
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    await requireSession();
    const { analysisId } = await ctx.params;
    deleteAnalysis(analysisId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
