import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { decideAnalysisDocument } from '@/lib/server/repo/analyses';

// The per-document confirmation gate (briefing §5.3).
export async function PATCH(req: Request, ctx: { params: Promise<{ analysisId: string; documentId: string }> }) {
  try {
    await requireSession();
    const { analysisId, documentId } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const status = String(body.status || '');
    if (status !== 'confirmed' && status !== 'excluded') {
      return NextResponse.json({ ok: false, error: "status must be 'confirmed' or 'excluded'." }, { status: 400 });
    }
    const documents = decideAnalysisDocument(analysisId, documentId, status);
    return NextResponse.json({ ok: true, documents });
  } catch (error) {
    return jsonError(error);
  }
}
