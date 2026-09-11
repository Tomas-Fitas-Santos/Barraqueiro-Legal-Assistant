import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { forkFromVersion, listPaths } from '@/lib/server/repo/versions';

// Track back: branch a new path from this version (v1<letter> starts here).
export async function POST(_req: Request, ctx: { params: Promise<{ analysisId: string; versionId: string }> }) {
  try {
    await requireSession();
    const { analysisId, versionId } = await ctx.params;
    const path = forkFromVersion(analysisId, versionId);
    return NextResponse.json({ ok: true, path, paths: listPaths(analysisId) });
  } catch (error) {
    return jsonError(error);
  }
}
