import { NextResponse } from 'next/server';

import { ApiError, jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { draftContent, draftGate, saveDraftContent } from '@/lib/server/repo/email-draft';
import { getAnalysis } from '@/lib/server/repo/analyses';

// The draft the user reads and edits in-app. Saving does not send anything — the app has
// no send path at all; the .eml download is built from exactly this content.
export async function GET(_req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    await requireSession();
    const { analysisId } = await ctx.params;
    const gate = draftGate(analysisId);
    return NextResponse.json({
      ok: true,
      content: draftContent(analysisId),
      attachment: gate.allowed ? gate.summary : null,
      allowed: gate.allowed,
      ...(gate.allowed ? {} : { reason: gate.reason }),
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    await requireSession();
    const { analysisId } = await ctx.params;
    const analysis = getAnalysis(analysisId);
    if (!analysis || analysis.state === 'eliminada') throw new ApiError('Analysis not found.', 404);
    if (analysis.closedAt) throw new ApiError('O e-mail aprovado já não pode ser alterado.', 409);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const content = saveDraftContent(analysisId, {
      ...(typeof body.to === 'string' ? { to: body.to } : {}),
      ...(typeof body.cc === 'string' ? { cc: body.cc } : {}),
      ...(typeof body.subject === 'string' ? { subject: body.subject } : {}),
      ...(typeof body.body === 'string' ? { body: body.body } : {}),
    });
    return NextResponse.json({ ok: true, content });
  } catch (error) {
    return jsonError(error);
  }
}
