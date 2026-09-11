import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { clearCodexToken } from '@/lib/server/ai/vendor/codex-token-store';

export async function POST() {
  return withSession(async () => {
    await clearCodexToken();
    return NextResponse.json({ ok: true });
  });
}
