import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { assertAction } from '@/lib/server/workflow';
import { startConversionForFinal } from '@/lib/server/repo/conversions';
import { listVersions, setFinalVersion } from '@/lib/server/repo/versions';

// Approving the document (§12) starts the whole chain: DOCX to OneDrive, Graph conversion,
// PDF to OneDrive, then the human's visual check. The response returns as soon as the
// conversion is under way — it reports its own progress and its own failure, and the PDF
// phase reads that rather than the request that started it.
export async function POST(_req: Request, ctx: { params: Promise<{ analysisId: string; versionId: string }> }) {
  try {
    await requireSession();
    const { analysisId, versionId } = await ctx.params;
    // The definition decides whether this is allowed, and supplies the refusal.
    await assertAction(analysisId, 'set_final');
    const version = setFinalVersion(analysisId, versionId);
    const conversion = startConversionForFinal(analysisId, versionId);
    return NextResponse.json({ ok: true, version, conversion, versions: listVersions(analysisId) });
  } catch (error) {
    return jsonError(error);
  }
}
