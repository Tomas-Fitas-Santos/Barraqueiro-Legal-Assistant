import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { codexOauth } from '@/lib/server/ai/vendor/codex-oauth';
import { saveToken } from '@/lib/server/ai/vendor/codex-auth-runtime';

export async function GET(req: Request) {
  return withSession(async () => {
    const state = String(new URL(req.url).searchParams.get('state') || '').trim();
    if (!state) return NextResponse.json({ ok: false, error: 'Missing state.' }, { status: 400 });
    const result = codexOauth().pollBrowserFlow(state);
    if (result.status === 'authorized') {
      await saveToken(result.token);
      return NextResponse.json({ ok: true, status: 'authorized' });
    }
    if (result.status === 'error') {
      return NextResponse.json({ ok: false, status: 'error', error: result.error });
    }
    return NextResponse.json({ ok: true, status: 'pending' });
  });
}
