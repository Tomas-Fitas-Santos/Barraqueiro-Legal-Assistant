import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { dismissAffected, getAnalysis } from '@/lib/server/repo/analyses';

// §15 gives the user a warning that a source changed. It was permanent and had no action:
// once raised it stayed on the analysis forever, whatever the user decided about it.
// Dismissing records the decision and clears the flag; the warning returns if the document
// changes again, because that is a new fact.
export async function DELETE(_req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    await requireSession();
    const { analysisId } = await ctx.params;
    const analysis = getAnalysis(analysisId);
    if (!analysis || analysis.state === 'eliminada') {
      return NextResponse.json({ ok: false, error: 'Analysis not found.' }, { status: 404 });
    }
    dismissAffected(analysisId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
