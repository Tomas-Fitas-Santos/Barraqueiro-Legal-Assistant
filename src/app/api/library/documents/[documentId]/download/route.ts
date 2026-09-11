import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { downloadItem } from '@/lib/server/msgraph';
import { getDocument } from '@/lib/server/repo/library';

// Stream a library file through the app (the browser never talks to Graph directly).
// ?inline=1 serves it for in-app preview (the PDF panel); the LOCAL original is preferred
// when present so previews work offline and cost no Graph round-trip. ?as=pdf asks for the
// PDF the document is READ through — the original itself when it is a PDF, its converted
// rendition when it is not, which is what the paged preview and citations refer to.
export async function GET(req: Request, ctx: { params: Promise<{ documentId: string }> }) {
  try {
    await requireSession();
    const { documentId } = await ctx.params;
    const doc = getDocument(documentId);
    if (!doc) return NextResponse.json({ ok: false, error: 'Document not found.' }, { status: 404 });
    const params = new URL(req.url).searchParams;
    const inline = params.get('inline') === '1';
    const asPdf = params.get('as') === 'pdf';
    const disposition = `${inline ? 'inline' : 'attachment'}; filename="${doc.name.replace(/"/g, '')}"`;

    const { getDb } = await import('@/lib/server/db');
    const { isPdfFile, originalPath } = await import('@/lib/server/ingest/pipeline');
    const { existsSync, readFileSync } = await import('node:fs');
    const row = getDb()
      .prepare('SELECT sha256, text_sha256 FROM documents WHERE document_id = ?')
      .get(documentId) as { sha256: string; text_sha256: string };
    const sha = String(row?.sha256 || '');
    const renditionSha = String(row?.text_sha256 || '');
    if (asPdf && renditionSha && existsSync(originalPath(renditionSha))) {
      return new Response(new Uint8Array(readFileSync(originalPath(renditionSha))), {
        headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': disposition },
      });
    }

    // A file the reading pipeline never touches has no rendition to find — a template is
    // not ingested on purpose, so its bytes may not even be here yet. Build one now, once
    // per content hash, so previewing a template shows it instead of downloading it.
    const { isReadableDocument } = await import('@/lib/library-layout');
    if (asPdf && !isReadableDocument(doc.path)) {
      const { previewRendition } = await import('@/lib/server/ingest/renditions');
      const built = await previewRendition(documentId);
      if (built && existsSync(built)) {
        return new Response(new Uint8Array(readFileSync(built)), {
          headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': disposition },
        });
      }
    }
    if (sha && existsSync(originalPath(sha))) {
      // Asked for a PDF and the original is not one, with no rendition stored: say so
      // rather than handing back bytes the viewer cannot render.
      if (asPdf && !isPdfFile(originalPath(sha))) {
        return NextResponse.json({ ok: false, error: 'Este documento ainda não tem versão PDF.' }, { status: 409 });
      }
      return new Response(new Uint8Array(readFileSync(originalPath(sha))), {
        headers: {
          'Content-Type': asPdf ? 'application/pdf' : doc.mime || 'application/pdf',
          'Content-Disposition': disposition,
        },
      });
    }
    const upstream = await downloadItem(doc.driveItemId);
    return new Response(upstream.body, {
      headers: { 'Content-Type': doc.mime || 'application/octet-stream', 'Content-Disposition': disposition },
    });
  } catch (error) {
    return jsonError(error);
  }
}
