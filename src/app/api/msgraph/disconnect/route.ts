import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { disconnectGraph } from '@/lib/server/msgraph';

export async function POST() {
  return withSession(async () => {
    disconnectGraph();
    return NextResponse.json({ ok: true });
  });
}
