import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { deleteFolder, folderImpact, moveItem, renameItem } from '@/lib/server/repo/library-items';
import { getDb } from '@/lib/server/db';

// Rename, move or delete a folder — and say first what a delete would take with it.
export async function GET(_req: Request, ctx: { params: Promise<{ folderId: string }> }) {
  return withSession(async () => {
    const { folderId } = await ctx.params;
    const row = getDb()
      .prepare('SELECT path FROM drive_folders WHERE folder_id = ? AND removed = 0')
      .get(folderId) as { path: string } | undefined;
    if (!row) return NextResponse.json({ ok: false, error: 'Pasta não encontrada.' }, { status: 404 });
    return NextResponse.json({ ok: true, path: row.path, impact: folderImpact(row.path) });
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ folderId: string }> }) {
  return withSession(async () => {
    const { folderId } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const ref = { kind: 'folder' as const, folderId };
    if (typeof body.parentPath === 'string') {
      return NextResponse.json({ ok: true, ...(await moveItem(ref, body.parentPath)) });
    }
    return NextResponse.json({ ok: true, ...(await renameItem(ref, String(body.name || ''))) });
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ folderId: string }> }) {
  return withSession(async () => {
    const { folderId } = await ctx.params;
    return NextResponse.json({ ok: true, ...(await deleteFolder(folderId)) });
  });
}
