import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { isLibraryConfigured } from '@/lib/server/msgraph';
import { lastSync } from '@/lib/server/repo/library';
import { libraryList, type ListSortDir, type ListSortKey } from '@/lib/server/repo/library-list';
import { hasPendingMigration } from '@/lib/server/repo/library-migration';

// One folder of the Library — the folders in it, a page of its files, and the breadcrumb.
//
// Replaces GET /api/library/documents, which returned the entire library on every page load.
export async function GET(req: Request) {
  return withSession(async () => {
    const params = new URL(req.url).searchParams;
    const result = libraryList({
      path: params.get('path') || '',
      sort: (params.get('sort') || 'name') as ListSortKey,
      dir: (params.get('dir') || 'asc') as ListSortDir,
      q: params.get('q') || '',
      recursive: params.get('recursive') === '1',
      cursor: params.get('cursor') || '',
      limit: Number(params.get('limit') || 100),
    });
    return NextResponse.json({
      ok: true,
      configured: isLibraryConfigured(),
      ...result,
      lastSync: lastSync(),
      migrationPending: hasPendingMigration(),
    });
  });
}
