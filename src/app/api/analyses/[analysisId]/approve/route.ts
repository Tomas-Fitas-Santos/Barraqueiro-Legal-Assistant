import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { assertAction } from '@/lib/server/workflow';
import { approveAnalysis } from '@/lib/server/repo/analyses';
import { generateVersion } from '@/lib/server/repo/versions';

// Approving the extraction is the gate of the Revisão phase — and the hand-off: the agent
// writes the document straight away, because that is what the approval is FOR. Waiting for
// a second click would only mean the user has to know that the next step exists.
export async function POST(_req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    const session = await requireSession();
    const { analysisId } = await ctx.params;
    // The definition decides whether this is allowed, and supplies the refusal.
    await assertAction(analysisId, 'approve_extraction');
    const analysis = approveAnalysis(analysisId, session.email);

    // A failure here leaves the approval standing — it is a fact about the extraction, not
    // about the document — and the Documento phase offers "Gerar documento" as usual.
    let generated = null;
    try {
      generated = await generateVersion(analysisId);
    } catch (error) {
      console.warn('[legal] Document generation after approval failed:', error);
    }
    return NextResponse.json({ ok: true, analysis, version: generated });
  } catch (error) {
    return jsonError(error);
  }
}
