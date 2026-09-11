import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { decideChatTurn, listTurns } from '@/lib/server/repo/chat';

// Confirm or discard a pending gated change (§13).
export async function PATCH(req: Request, ctx: { params: Promise<{ analysisId: string; turnId: string }> }) {
  try {
    await requireSession();
    const { analysisId, turnId } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const decision = String(body.decision || '');
    if (decision !== 'confirm' && decision !== 'discard') {
      return NextResponse.json({ ok: false, error: "decision must be 'confirm' or 'discard'." }, { status: 400 });
    }
    const turn = decideChatTurn(analysisId, turnId, decision);
    return NextResponse.json({ ok: true, turn, turns: listTurns(analysisId) });
  } catch (error) {
    return jsonError(error);
  }
}
