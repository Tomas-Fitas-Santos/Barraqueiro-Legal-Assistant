import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { proposeRelations, listRelations } from '@/lib/server/repo/relations';

// Run the proposal engine for a document: deterministic shortlist → one AI judgement call
// (or the heuristic degraded run when no AI) → app-enforced rules → proposed rows.
export async function POST(_req: Request, ctx: { params: Promise<{ documentId: string }> }) {
  try {
    await requireSession();
    const { documentId } = await ctx.params;
    const run = await proposeRelations(documentId);
    return NextResponse.json({ ok: true, run, relations: listRelations(documentId) });
  } catch (error) {
    return jsonError(error);
  }
}
