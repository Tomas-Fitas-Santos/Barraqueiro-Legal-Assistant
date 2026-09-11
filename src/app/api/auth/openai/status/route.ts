import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { loadToken } from '@/lib/server/ai/vendor/codex-auth-runtime';

export async function GET() {
  return withSession(async () => {
    const token = await loadToken();
    if (!token) return NextResponse.json({ ok: true, authenticated: false });
    return NextResponse.json({
      ok: true,
      authenticated: Boolean(token.access),
      expires: token.expires,
      accountId: token.accountId,
      email: token.email,
      displayName: token.displayName,
    });
  });
}
