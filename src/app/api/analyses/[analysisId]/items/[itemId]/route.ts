import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { decideItem, listItems } from '@/lib/server/repo/analyses';

// Per-line matrix decision (briefing §5.4) — accept or reject a validated line.
export async function PATCH(req: Request, ctx: { params: Promise<{ analysisId: string; itemId: string }> }) {
  try {
    await requireSession();
    const { analysisId, itemId } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const decision = String(body.decision || '');
    if (decision !== 'accepted' && decision !== 'rejected') {
      return NextResponse.json({ ok: false, error: "decision must be 'accepted' or 'rejected'." }, { status: 400 });
    }
    decideItem(analysisId, itemId, decision);
    return NextResponse.json({ ok: true, items: listItems(analysisId) });
  } catch (error) {
    return jsonError(error);
  }
}
