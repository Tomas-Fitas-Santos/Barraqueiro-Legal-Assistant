import { NextResponse } from 'next/server';

import { ApiError, jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { recordEvent } from '@/lib/server/repo/analyses';
import { listVersions, renderVersionFromSections } from '@/lib/server/repo/versions';

// Manual in-app editing of a generated document: the user edits the narrative sections and
// saves — which produces a NEW immutable version (§14: nothing is ever edited in place).
export async function POST(req: Request, ctx: { params: Promise<{ analysisId: string; versionId: string }> }) {
  try {
    await requireSession();
    const { analysisId } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const sections = Array.isArray(body.sections)
      ? body.sections
          .map((s) => s as { heading?: unknown; body?: unknown })
          .map((s) => ({ heading: String(s.heading || '').trim(), body: String(s.body || '').trim() }))
          .filter((s) => s.heading || s.body)
      : [];
    if (sections.length === 0) throw new ApiError('O documento não pode ficar vazio.', 400);

    const version = renderVersionFromSections({
      analysisId,
      origin: 'chat_change',
      sections,
      note: 'Editado manualmente na aplicação',
    });
    recordEvent(analysisId, 'version_edited_in_app', { versionNo: version.versionNo, label: version.label });
    return NextResponse.json({ ok: true, version, versions: listVersions(analysisId) });
  } catch (error) {
    return jsonError(error);
  }
}
