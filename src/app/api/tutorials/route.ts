import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { tutorialCatalog } from '@/lib/server/repo/tutorials';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const session = await requireSession();
    return NextResponse.json({ ok: true, tutorials: tutorialCatalog(session.email) });
  } catch (error) {
    return jsonError(error);
  }
}
