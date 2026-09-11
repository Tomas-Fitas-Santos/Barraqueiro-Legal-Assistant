import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { decideRelation } from '@/lib/server/repo/relations';

// Confirm or reject a proposed relation — the per-document human gate (briefing §5.3).
export async function PATCH(req: Request, ctx: { params: Promise<{ relationId: string }> }) {
  try {
    await requireSession();
    const { relationId } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const decision = String(body.decision || '');
    if (decision !== 'confirmed' && decision !== 'rejected') {
      return NextResponse.json({ ok: false, error: "decision must be 'confirmed' or 'rejected'." }, { status: 400 });
    }
    const relation = decideRelation(relationId, decision);
    return NextResponse.json({ ok: true, relation });
  } catch (error) {
    return jsonError(error);
  }
}
