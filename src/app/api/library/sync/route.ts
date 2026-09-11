import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { syncLibrary } from '@/lib/server/repo/library';

// "Sync now" — interactive, so errors surface to the caller rather than only to health.
export async function POST() {
  return withSession(async () => {
    const result = await syncLibrary();
    if (result.status === 'not_configured') {
      return NextResponse.json({ ok: false, error: 'Library is not configured yet.' }, { status: 400 });
    }
    return NextResponse.json({ ok: true, ...result });
  });
}
