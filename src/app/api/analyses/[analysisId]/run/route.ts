import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { assertAction } from '@/lib/server/workflow';
import { runAnalysis } from '@/lib/server/repo/analyses';

export async function POST(_req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    await requireSession();
    const { analysisId } = await ctx.params;
    // The definition decides whether this is allowed, and supplies the refusal.
    await assertAction(analysisId, 'run');
    const analysis = await runAnalysis(analysisId);
    return NextResponse.json({ ok: true, analysis });
  } catch (error) {
    return jsonError(error);
  }
}
