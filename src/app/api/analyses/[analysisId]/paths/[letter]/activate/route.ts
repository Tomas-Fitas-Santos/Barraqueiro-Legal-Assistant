import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { switchActivePath } from '@/lib/server/repo/versions';

export async function POST(_req: Request, ctx: { params: Promise<{ analysisId: string; letter: string }> }) {
  try {
    await requireSession();
    const { analysisId, letter } = await ctx.params;
    switchActivePath(analysisId, letter);
    return NextResponse.json({ ok: true, activePath: letter });
  } catch (error) {
    return jsonError(error);
  }
}
