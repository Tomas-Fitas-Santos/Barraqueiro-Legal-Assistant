import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { fixtureForRun, requireTutorialRun, updateTutorialRun } from '@/lib/server/repo/tutorials';
import { tutorialDefinition } from '@/lib/tutorials';

export const runtime = 'nodejs';

type Context = { params: Promise<{ runId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const session = await requireSession();
    const { runId } = await context.params;
    const run = requireTutorialRun(runId, session.email);
    return NextResponse.json({ ok: true, run, tutorial: tutorialDefinition(run.kind), fixture: fixtureForRun(runId, session.email) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const session = await requireSession();
    const { runId } = await context.params;
    const body = await request.json().catch(() => ({})) as { action?: unknown; key?: unknown; value?: unknown };
    const run = updateTutorialRun(runId, session.email, {
      action: typeof body.action === 'string' ? body.action : '',
      key: typeof body.key === 'string' ? body.key : undefined,
      value: body.value,
    });
    return NextResponse.json({ ok: true, run });
  } catch (error) {
    return jsonError(error);
  }
}
