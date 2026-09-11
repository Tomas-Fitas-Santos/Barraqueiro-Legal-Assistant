import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { fixtureForRun, tutorialFixtureBytes } from '@/lib/server/repo/tutorials';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const session = await requireSession();
    const { runId } = await params;
    const fixture = fixtureForRun(runId, session.email);
    const result = tutorialFixtureBytes(fixture.fixtureId);
    return new NextResponse(result.bytes, {
      headers: {
        'Content-Type': result.fixture.sourceMime || 'application/octet-stream',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(result.fixture.sourceName)}`,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
