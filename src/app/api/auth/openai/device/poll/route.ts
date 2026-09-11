import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { codexOauth } from '@/lib/server/ai/vendor/codex-oauth';
import { saveToken } from '@/lib/server/ai/vendor/codex-auth-runtime';

export async function GET(req: Request) {
  return withSession(async () => {
    const pollId = String(new URL(req.url).searchParams.get('pollId') || '').trim();
    if (!pollId) return NextResponse.json({ ok: false, error: 'Missing pollId.' }, { status: 400 });
    try {
      const result = await codexOauth().pollDeviceFlow(pollId);
      if (result.status === 'authorized' && result.token) {
        await saveToken(result.token);
        return NextResponse.json({ ok: true, status: 'authorized' });
      }
      return NextResponse.json({ ok: true, status: 'pending' });
    } catch (error) {
      return NextResponse.json({
        ok: false,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
