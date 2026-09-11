import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { healthReport } from '@/lib/server/health';

export async function GET() {
  return withSession(async () => {
    const report = await healthReport();
    return NextResponse.json({ ok: true, ...report });
  });
}
