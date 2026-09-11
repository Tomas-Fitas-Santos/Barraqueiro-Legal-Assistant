import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import {
  createTutorialFixture,
  listTutorialFixtures,
  parseTutorialKind,
  tutorialFixtureCandidates,
} from '@/lib/server/repo/tutorials';

export const runtime = 'nodejs';

export async function GET() {
  try {
    await requireSession();
    return NextResponse.json({ ok: true, fixtures: listTutorialFixtures(), candidates: tutorialFixtureCandidates() });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireSession();
    const body = await request.json().catch(() => ({})) as { kind?: unknown; documentId?: unknown };
    const documentId = typeof body.documentId === 'string' ? body.documentId : '';
    if (!documentId) return NextResponse.json({ ok: false, error: 'Escolha um documento.' }, { status: 400 });
    const fixture = createTutorialFixture(parseTutorialKind(body.kind), documentId);
    return NextResponse.json({ ok: true, fixture }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
