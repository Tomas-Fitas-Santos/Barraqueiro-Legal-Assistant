import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { isLibraryConfigured } from '@/lib/server/msgraph';
import { lastSync, listDocuments, listFolders } from '@/lib/server/repo/library';

export async function GET(req: Request) {
  return withSession(async () => {
    const includeRemoved = new URL(req.url).searchParams.get('includeRemoved') === '1';
    return NextResponse.json({
      ok: true,
      configured: isLibraryConfigured(),
      documents: listDocuments({ includeRemoved }),
      folders: listFolders(),
      lastSync: lastSync(),
    });
  });
}
