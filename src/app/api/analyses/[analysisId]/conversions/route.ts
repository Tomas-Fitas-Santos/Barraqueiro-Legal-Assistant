import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { listConversions } from '@/lib/server/repo/conversions';

export async function GET(_req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    await requireSession();
    const { analysisId } = await ctx.params;
    return NextResponse.json({ ok: true, conversions: listConversions(analysisId) });
  } catch (error) {
    return jsonError(error);
  }
}
