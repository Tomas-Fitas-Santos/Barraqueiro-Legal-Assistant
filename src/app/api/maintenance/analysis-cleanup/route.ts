import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import {
  analysisCleanupInventory,
  executeAnalysisCleanup,
} from '@/lib/server/repo/analysis-cleanup';

export const runtime = 'nodejs';

/** Dry-run only: this endpoint never mutates data. */
export async function GET() {
  try {
    await requireSession();
    return NextResponse.json({ ok: true, inventory: analysisCleanupInventory() });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Destructive execution is deliberately awkward and has no UI button. The exact hash from
 * a fresh GET plus the scope phrase must both be supplied after a separate DB backup and
 * explicit human approval.
 */
export async function POST(request: Request) {
  try {
    await requireSession();
    const body = await request.json().catch(() => ({})) as { inventoryHash?: unknown; confirmation?: unknown };
    const result = await executeAnalysisCleanup(
      typeof body.inventoryHash === 'string' ? body.inventoryHash : '',
      typeof body.confirmation === 'string' ? body.confirmation : '',
    );
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error);
  }
}
