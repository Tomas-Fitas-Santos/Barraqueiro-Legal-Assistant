import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { assertAction } from '@/lib/server/workflow';
import { listTurns, sendChatMessage } from '@/lib/server/repo/chat';

export async function GET(_req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    await requireSession();
    const { analysisId } = await ctx.params;
    return NextResponse.json({ ok: true, turns: listTurns(analysisId) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    await requireSession();
    const { analysisId } = await ctx.params;
    // The definition decides whether this is allowed, and supplies the refusal.
    await assertAction(analysisId, 'chat_send');
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const turn = await sendChatMessage(analysisId, String(body.message || ''));
    return NextResponse.json({ ok: true, turn, turns: listTurns(analysisId) });
  } catch (error) {
    return jsonError(error);
  }
}
