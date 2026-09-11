import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { getVersion, readVersionBytes } from '@/lib/server/repo/versions';

export async function GET(_req: Request, ctx: { params: Promise<{ analysisId: string; versionId: string }> }) {
  try {
    await requireSession();
    const { analysisId, versionId } = await ctx.params;
    const version = getVersion(analysisId, versionId);
    const bytes = readVersionBytes(version);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${version.filename}"`,
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
