import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { getCodexPlanUsage } from '@/lib/server/ai/vendor/codex-usage';

export async function GET() {
  return withSession(async () => {
    try {
      const usage = await getCodexPlanUsage();
      return NextResponse.json({ ok: true, usage });
    } catch (error) {
      return NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 502 },
      );
    }
  });
}
