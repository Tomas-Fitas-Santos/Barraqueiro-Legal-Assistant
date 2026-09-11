import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { getSetting, setSetting } from '@/lib/server/db';
import { driveId, folderAbsolutePath } from '@/lib/server/msgraph';
import {
  ensureLibraryReady,
  markLibraryMoved,
  resetDriveScopedState,
  syncLibraryInBackground,
} from '@/lib/server/repo/library';

// Choose the library folder. Changing it resets the delta cursor — the next sync
// re-enumerates the new folder from scratch (existing rows for vanished items are marked
// removed by the delta feed of the new folder only if they reappear there; a folder change
// on a live deployment is an operator decision, not an everyday action).
export async function POST(req: Request) {
  return withSession(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const folderId = String(body.folderId || '').trim();
    const folderName = String(body.folderName || '').trim();
    if (!folderId || !folderName) {
      return NextResponse.json({ ok: false, error: 'folderId and folderName are required.' }, { status: 400 });
    }
    const previousFolderId = String(getSetting('graph.library_folder_id') || '');
    const previousFolderName = String(getSetting('graph.library_folder_name') || '');
    setSetting('graph.drive_id', await driveId());
    setSetting('graph.library_folder_id', folderId);
    setSetting('graph.library_folder_name', folderName);
    // The folder's absolute Graph path, so an incremental delta can resolve a file's folder
    // from its own parentReference instead of guessing the root. See relativePath().
    // Best-effort: a sync backfills it later if this call fails.
    setSetting('graph.library_folder_path', await folderAbsolutePath(folderId).catch(() => ''));
    resetDriveScopedState();
    // Moving the library WITHIN one account leaves the documents behind exactly as changing
    // account does, so it raises exactly the same question: bring them across, or not.
    if (previousFolderId && previousFolderId !== folderId) {
      markLibraryMoved({
        accountEmail: String(getSetting('graph.account_email') || ''),
        folderName: previousFolderName,
        sameAccount: true,
      });
    }

    // Awaited, so the picker reports a failure instead of silently leaving the library
    // without the folders the rest of the app assumes are there.
    const structure = await ensureLibraryReady();
    syncLibraryInBackground('folder-selected');
    return NextResponse.json({ ok: true, created: structure.created });
  });
}
