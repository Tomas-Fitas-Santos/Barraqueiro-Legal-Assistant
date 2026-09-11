import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { ingestDocument, storeOriginalBytes } from '@/lib/server/ingest/pipeline';
import { maxUploadBytes } from '@/lib/server/paths';
import { getDocument } from '@/lib/server/repo/library';

// Stage a document's original bytes directly (dev/offline door — production bytes normally
// arrive via the Graph download inside ingest). Stores content-addressed, stamps the hash,
// then runs the full pipeline.
export async function PUT(req: Request, ctx: { params: Promise<{ documentId: string }> }) {
  try {
    await requireSession();
    const { documentId } = await ctx.params;
    const doc = getDocument(documentId);
    if (!doc) return NextResponse.json({ ok: false, error: 'Document not found.' }, { status: 404 });

    const bytes = Buffer.from(await req.arrayBuffer());
    if (bytes.length === 0) {
      return NextResponse.json({ ok: false, error: 'Empty upload.' }, { status: 400 });
    }
    if (bytes.length > maxUploadBytes()) {
      return NextResponse.json({ ok: false, error: 'File too large.' }, { status: 413 });
    }

    // Store content-addressed and hand the hash to the pipeline — it owns the sha stamp
    // and the content-change consequences (§15 flagging fires there).
    const sha = storeOriginalBytes(bytes);
    const result = await ingestDocument(documentId, { force: true, stagedSha: sha });
    return NextResponse.json({ ok: true, sha256: sha, result });
  } catch (error) {
    return jsonError(error);
  }
}
