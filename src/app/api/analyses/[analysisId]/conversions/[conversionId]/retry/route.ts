import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { assertAction } from '@/lib/server/workflow';
import { retryConversion } from '@/lib/server/repo/conversions';

export async function POST(_req: Request, ctx: { params: Promise<{ analysisId: string; conversionId: string }> }) {
  try {
    await requireSession();
    const { analysisId, conversionId } = await ctx.params;
    // The definition decides whether this is allowed, and supplies the refusal.
    await assertAction(analysisId, 'retry_conversion');
    const conversion = await retryConversion(analysisId, conversionId);
    return NextResponse.json({ ok: true, conversion });
  } catch (error) {
    return jsonError(error);
  }
}
