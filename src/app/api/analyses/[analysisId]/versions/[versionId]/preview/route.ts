import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { buildReferenceList } from '@/lib/server/docx';
import { listItems } from '@/lib/server/repo/analyses';
import { getVersion } from '@/lib/server/repo/versions';
import { getDb } from '@/lib/server/db';

// In-app preview of a version: its narrative sections + the reference list resolved to
// documentId/page so every [n] marker is clickable straight to its source.
export async function GET(_req: Request, ctx: { params: Promise<{ analysisId: string; versionId: string }> }) {
  try {
    await requireSession();
    const { analysisId, versionId } = await ctx.params;
    const version = getVersion(analysisId, versionId);
    const row = getDb()
      .prepare('SELECT sections_json FROM analysis_versions WHERE version_id = ?')
      .get(versionId) as { sections_json: string };
    const sections = row.sections_json ? JSON.parse(row.sections_json) : null;
    const items = listItems(analysisId).filter((item) => item.accepted && item.decision !== 'rejected');
    return NextResponse.json({
      ok: true,
      version,
      sections,
      references: buildReferenceList(items),
    });
  } catch (error) {
    return jsonError(error);
  }
}
