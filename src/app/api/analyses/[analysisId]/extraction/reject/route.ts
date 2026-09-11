import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { rejectAnalysisExtraction } from '@/lib/server/repo/analyses';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ analysisId: string }> }) {
  try {
    const session = await requireSession();
    const { analysisId } = await params;
    const body = await request.json().catch(() => ({})) as { reason?: unknown };
    const result = rejectAnalysisExtraction(
      analysisId,
      session.email,
      typeof body.reason === 'string' ? body.reason : '',
    );
    return NextResponse.json({ ok: true, restart: 'run', ...result });
  } catch (error) {
    return jsonError(error);
  }
}
