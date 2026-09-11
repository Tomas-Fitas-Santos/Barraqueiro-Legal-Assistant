import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { login } from '@/lib/server/auth';
import { syncLibraryInBackground } from '@/lib/server/repo/library';

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const session = await login(String(body.email || ''), String(body.password || ''));
    // Briefing: sync on login (best-effort, never delays the sign-in response).
    syncLibraryInBackground('login');
    return NextResponse.json({ ok: true, session });
  } catch (error) {
    return jsonError(error);
  }
}
