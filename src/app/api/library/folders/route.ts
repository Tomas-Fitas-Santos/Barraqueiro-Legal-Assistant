import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { createFolder } from '@/lib/server/repo/library-items';

// Create a folder in the client's library. Refuses a name that is already taken — unlike the
// structural folders the app maintains, which reuse an existing folder on purpose.
export async function POST(req: Request) {
  return withSession(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await createFolder(String(body.parentPath || ''), String(body.name || ''));
    return NextResponse.json({ ok: true, ...result });
  });
}
