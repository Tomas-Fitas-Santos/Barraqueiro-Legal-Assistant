import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { assertAction } from '@/lib/server/workflow';
import { generateVersion, listVersions } from '@/lib/server/repo/versions';

export async function GET(_req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    await requireSession();
    const { analysisId } = await ctx.params;
    return NextResponse.json({ ok: true, versions: listVersions(analysisId) });
  } catch (error) {
    return jsonError(error);
  }
}

// Generate a new DOCX version from the validated items (narrative + template render).
export async function POST(_req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    await requireSession();
    const { analysisId } = await ctx.params;
    // The definition decides whether this is allowed, and supplies the refusal.
    await assertAction(analysisId, 'generate_version');
    const version = await generateVersion(analysisId);
    return NextResponse.json({ ok: true, version, versions: listVersions(analysisId) });
  } catch (error) {
    return jsonError(error);
  }
}
