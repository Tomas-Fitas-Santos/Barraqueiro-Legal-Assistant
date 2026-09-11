import { ApiError, jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { getAnalysis } from '@/lib/server/repo/analyses';
import { buildEmlDraft } from '@/lib/server/repo/email-draft';

// Download is separate from approval: it is available after the analysis has concluded,
// creates no new decision, and still attaches only the approved current PDF.
export async function POST(_req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    await requireSession();
    const { analysisId } = await ctx.params;
    const analysis = getAnalysis(analysisId);
    if (!analysis || analysis.state === 'eliminada') throw new ApiError('Analysis not found.', 404);
    if (!analysis.closedAt) throw new ApiError('Aprove primeiro o e-mail.', 409);
    const draft = buildEmlDraft(analysisId, {});
    return new Response(new Uint8Array(draft.bytes), {
      headers: {
        'Content-Type': 'message/rfc822',
        'Content-Disposition': `attachment; filename="${draft.filename}"`,
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
