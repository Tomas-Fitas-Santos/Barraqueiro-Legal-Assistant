import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { listTemplates, refreshLibraryTemplates } from '@/lib/server/repo/templates';

export async function GET() {
  return withSession(async () => {
    // Pick up anything the client has dropped into the library's Templates folders since
    // the last look, so a template appears without waiting for a sync.
    await refreshLibraryTemplates().catch((error) => {
      console.warn('[legal] Could not refresh library templates:', error instanceof Error ? error.message : error);
    });
    return NextResponse.json({ ok: true, templates: listTemplates() });
  });
}
