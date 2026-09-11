import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { createTutorialRun, parseTutorialKind } from '@/lib/server/repo/tutorials';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const body = await request.json().catch(() => ({})) as { kind?: unknown };
    const run = createTutorialRun(parseTutorialKind(body.kind), session.email);
    return NextResponse.json({ ok: true, run }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
