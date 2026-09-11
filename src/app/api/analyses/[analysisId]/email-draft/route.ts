import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { assertAction } from '@/lib/server/workflow';
import { closeAnalysis, recordEvent } from '@/lib/server/repo/analyses';
import { draftContent, draftGate } from '@/lib/server/repo/email-draft';

// §16: GET exposes the gate; POST records the final human approval and closes the
// analysis. Downloading the approved draft is deliberately a separate action.
export async function GET(_req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    await requireSession();
    const { analysisId } = await ctx.params;
    const gate = draftGate(analysisId);
    return NextResponse.json(
      gate.allowed ? { ok: true, allowed: true, summary: gate.summary } : { ok: true, allowed: false, reason: gate.reason },
    );
  } catch (error) {
    return jsonError(error);
  }
}

// Approval is one click and one state transition. Reverting to an earlier phase is what
// reopens a concluded analysis.
export async function POST(_req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    const session = await requireSession();
    const { analysisId } = await ctx.params;
    await assertAction(analysisId, 'approve_email');
    const gate = draftGate(analysisId);
    if (!gate.allowed) return NextResponse.json({ ok: false, error: gate.reason }, { status: 409 });
    const content = draftContent(analysisId);
    recordEvent(analysisId, 'email_approved', {
      pdfName: gate.summary.pdfName,
      docxVersionNo: gate.summary.docxVersionNo,
      to: content.to,
    });
    const analysis = closeAnalysis(analysisId, session.email);
    return NextResponse.json({ ok: true, analysis });
  } catch (error) {
    return jsonError(error);
  }
}
