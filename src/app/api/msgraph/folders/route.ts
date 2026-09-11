import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { listChildFolders } from '@/lib/server/msgraph';

// Folder picker: child folders of `parentId` ('' = the drive root).
export async function GET(req: Request) {
  return withSession(async () => {
    const parentId = String(new URL(req.url).searchParams.get('parentId') || '');
    const folders = await listChildFolders(parentId);
    return NextResponse.json({ ok: true, folders });
  });
}
