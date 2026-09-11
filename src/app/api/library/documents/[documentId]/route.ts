import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { isReadableDocument, isTemplateFolder } from '@/lib/library-layout';
import { requireSession } from '@/lib/server/auth';
import {
  builtinTemplateIdForFilename,
  emailTemplateIdForFilename,
  extractionTemplateIdForFilename,
} from '@/lib/server/repo/templates';
import { getDb } from '@/lib/server/db';
import { staleOcrPages } from '@/lib/server/ingest/pipeline';
import { listPages } from '@/lib/server/ingest/pages';
import { previewPages } from '@/lib/server/ingest/renditions';
import { deleteItem, isLibraryConfigured } from '@/lib/server/msgraph';
import { analysisOfGeneratedDocument, listAnalysesForDocument } from '@/lib/server/repo/analyses';
import { applyUserMetadata, clearUserMetadata, metadataField } from '@/lib/server/repo/document-metadata';
import { getDocument, getDocumentDetail } from '@/lib/server/repo/library';
import { listRelationGroups } from '@/lib/server/repo/relations';

// Full detail: metadata + classification + per-page text (single-user app; the page text
// is the citation ground truth and the UI shows it), plus the two panels the detail page
// needs to be complete — every edge touching this document in both directions, and every
// analysis that used it with what each one produced.
export async function GET(_req: Request, ctx: { params: Promise<{ documentId: string }> }) {
  try {
    await requireSession();
    const { documentId } = await ctx.params;
    const detail = getDocumentDetail(documentId);
    if (!detail) return NextResponse.json({ ok: false, error: 'Document not found.' }, { status: 404 });
    const pageRows = listPages(documentId);
    const relations = listRelationGroups(documentId);
    const analyses = listAnalysesForDocument(documentId);
    return NextResponse.json({
      ok: true,
      // Keep the original top-level detail contract for existing clients while the rebuilt
      // screen consumes the explicit `document` object. Both views describe the same row.
      ...detail,
      document: detail,
      // Extracted pages win: a document MOVED into Templates keeps showing its text, which
      // is the whole reason its pages are kept when it stops being source material. Only a
      // file that was never ingested falls back to its rendition's text — and that text is
      // never written to document_pages, so the app can still not cite its own output.
      pages: pageRows.length || isReadableDocument(detail.path) ? pageRows : previewPages(documentId),
      relations,
      analyses,
      workCounts: {
        relations: relations.filter((relation) => relation.status === 'proposed').length,
        analyses: analyses.filter((analysis) => !analysis.closedAt).length,
      },
      // Set when this document IS an analysis's output, so the page can say where it came
      // from instead of presenting a generated file as if it were client source material.
      generatedBy: analysisOfGeneratedDocument(detail.driveItemId, detail.sha256),
      // Not an error, an offer: these pages read fine, they were just transcribed by an
      // older prompt that did not ask for structure.
      staleOcrPages: staleOcrPages(documentId),
      // Set when this file is the app's own template published into the library, so the page
      // can offer to edit the blocks it is rendered from rather than only to download it.
      editableTemplateId: isTemplateFolder(detail.path)
        ? builtinTemplateIdForFilename(detail.name) ||
          emailTemplateIdForFilename(detail.name) ||
          extractionTemplateIdForFilename(detail.name)
        : '',
    });
  } catch (error) {
    return jsonError(error);
  }
}

// User-correctable metadata (briefing §8: classification is a proposal, the user decides).
export async function PATCH(req: Request, ctx: { params: Promise<{ documentId: string }> }) {
  try {
    await requireSession();
    const { documentId } = await ctx.params;
    if (!getDocument(documentId)) {
      return NextResponse.json({ ok: false, error: 'Document not found.' }, { status: 404 });
    }
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    // `name` and `folderPath` are not columns to be written — they are operations against
    // the client's drive, with their own rules (an extension may not change; the app's own
    // output folder does not receive files). Route them rather than letting a raw column
    // write put the mirror and the drive out of step.
    const ref = { kind: 'file' as const, documentId };
    if (typeof body.name === 'string' && body.name.trim()) {
      const { renameItem } = await import('@/lib/server/repo/library-items');
      return NextResponse.json({ ok: true, ...(await renameItem(ref, body.name)) });
    }
    if (typeof body.folderPath === 'string') {
      const { moveItem } = await import('@/lib/server/repo/library-items');
      return NextResponse.json({ ok: true, ...(await moveItem(ref, body.folderPath)) });
    }

    // `reset` takes the AI's answer back for a field the user had corrected. It is the
    // opposite of a write, so it is handled before them and never in the same request.
    if (Array.isArray(body.reset)) {
      const cleared = clearUserMetadata(documentId, body.reset.map((k) => String(k)));
      return NextResponse.json({ ok: true, cleared, document: getDocumentDetail(documentId) });
    }

    const writes = Object.keys(body)
      .filter((key) => metadataField(key))
      .map((key) => ({ key, value: body[key] }));
    const applied = applyUserMetadata(documentId, writes);
    return NextResponse.json({ ok: true, corrected: applied, document: getDocumentDetail(documentId) });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Delete a document from the library. It goes from OneDrive too (the library is that
 * folder — deleting only locally would just bring it back on the next sync), and the row
 * is marked removed rather than dropped, so an analysis that already cited this document
 * still resolves its citations instead of pointing at nothing.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ documentId: string }> }) {
  try {
    await requireSession();
    const { documentId } = await ctx.params;
    const doc = getDocument(documentId);
    if (!doc) return NextResponse.json({ ok: false, error: 'Document not found.' }, { status: 404 });

    let deletedOnDrive = false;
    if (isLibraryConfigured() && doc.driveItemId && !doc.driveItemId.startsWith('local-')) {
      await deleteItem(doc.driveItemId);
      deletedOnDrive = true;
    }
    getDb()
      .prepare("UPDATE documents SET removed = 1, state_detail = 'Eliminado pelo utilizador.', updated_at = ? WHERE document_id = ?")
      .run(Date.now(), documentId);
    return NextResponse.json({ ok: true, deletedOnDrive });
  } catch (error) {
    return jsonError(error);
  }
}
