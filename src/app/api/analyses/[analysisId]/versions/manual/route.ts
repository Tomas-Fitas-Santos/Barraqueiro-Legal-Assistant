import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { maxUploadBytes } from '@/lib/server/paths';
import { addManualVersion, listVersions } from '@/lib/server/repo/versions';

// §14: upload a manually edited DOCX as a new immutable version.
export async function PUT(req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    await requireSession();
    const { analysisId } = await ctx.params;
    const bytes = Buffer.from(await req.arrayBuffer());
    if (bytes.length === 0) return NextResponse.json({ ok: false, error: 'Empty upload.' }, { status: 400 });
    if (bytes.length > maxUploadBytes()) {
      return NextResponse.json({ ok: false, error: 'File too large.' }, { status: 413 });
    }
    const version = addManualVersion(analysisId, bytes);
    return NextResponse.json({ ok: true, version, versions: listVersions(analysisId) });
  } catch (error) {
    return jsonError(error);
  }
}
