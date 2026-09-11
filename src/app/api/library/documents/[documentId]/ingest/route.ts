import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { ingestDocument } from '@/lib/server/ingest/pipeline';

// (Re-)run the ingestion pipeline for one document. Fetches from Graph when no local
// original exists; 400 when neither is available.
export async function POST(req: Request, ctx: { params: Promise<{ documentId: string }> }) {
  try {
    await requireSession();
    const { documentId } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    // A re-transcription is a real per-page bill, so it forces a re-ingest with it — there
    // is no point paying for pages the pipeline would then skip.
    const reocr = body.reocr === true;
    const result = await ingestDocument(documentId, { force: body.force === true || reocr, reocr });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return jsonError(error);
  }
}
