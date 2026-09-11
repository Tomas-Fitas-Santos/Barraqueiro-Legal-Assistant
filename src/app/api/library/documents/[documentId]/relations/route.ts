import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { addManualRelation, listRelations } from '@/lib/server/repo/relations';
import { getDocument } from '@/lib/server/repo/library';
import { isRelationType } from '@/lib/types';

export async function GET(_req: Request, ctx: { params: Promise<{ documentId: string }> }) {
  try {
    await requireSession();
    const { documentId } = await ctx.params;
    if (!getDocument(documentId)) return NextResponse.json({ ok: false, error: 'Document not found.' }, { status: 404 });
    return NextResponse.json({ ok: true, relations: listRelations(documentId) });
  } catch (error) {
    return jsonError(error);
  }
}

// Manual add (briefing: the user can always assert a relation) — born confirmed.
export async function POST(req: Request, ctx: { params: Promise<{ documentId: string }> }) {
  try {
    await requireSession();
    const { documentId } = await ctx.params;
    if (!getDocument(documentId)) return NextResponse.json({ ok: false, error: 'Document not found.' }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const type = String(body.type || '');
    if (!isRelationType(type)) return NextResponse.json({ ok: false, error: 'Unknown relation type.' }, { status: 400 });
    const relation = addManualRelation(documentId, String(body.toDocumentId || ''), type);
    return NextResponse.json({ ok: true, relation });
  } catch (error) {
    return jsonError(error);
  }
}
