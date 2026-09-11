import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { confirmedDocumentIds, getAnalysis, recordEvent } from '@/lib/server/repo/analyses';
import { currentExtraction, extractionItems, listExtractions, storeExtraction } from '@/lib/server/repo/extractions';
import { getDocument } from '@/lib/server/repo/library';
import { lineageOrder } from '@/lib/server/workflow';
import { crossCheckExtractionEdit } from '@/lib/server/chat-rules';
import type { SourcedItem } from '@/lib/server/analysis-rules';

// The extraction as the user reviews it: never raw JSON, but the same structured output
// rendered — every citation resolvable to a document the panel can open, and every segment
// carrying the confidence the model reported.

export async function GET(req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    await requireSession();
    const { analysisId } = await ctx.params;
    const analysis = getAnalysis(analysisId);
    if (!analysis || analysis.state === 'eliminada') {
      return NextResponse.json({ ok: false, error: 'Analysis not found.' }, { status: 404 });
    }
    const path = new URL(req.url).searchParams.get('path') || undefined;
    const extraction = currentExtraction(analysisId, lineageOrder(analysisId, path));
    if (!extraction) return NextResponse.json({ ok: true, extraction: null, items: [], sources: [] });

    const items = extractionItems(extraction.extractionId);
    // The documents the items cite, so the review surface can name and open them without
    // a lookup per citation.
    const sources = [...new Set(items.map((i) => String(i.payload.source_document_id || '')).filter(Boolean))]
      .map((documentId) => {
        const doc = getDocument(documentId);
        return doc ? { documentId, name: doc.name, title: doc.title } : null;
      })
      .filter(Boolean);

    return NextResponse.json({
      ok: true,
      extraction,
      history: listExtractions(analysisId).filter((e) => e.pathLetter === extraction.pathLetter),
      items,
      sources,
    });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Save a hand-edited extraction. It becomes a NEW extraction — the one it was edited from
 * stays exactly as it was — and every item is re-validated on the way in, so an edit
 * cannot introduce a citation the app has not checked (§11).
 */
export async function PUT(req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    await requireSession();
    const { analysisId } = await ctx.params;
    const analysis = getAnalysis(analysisId);
    if (!analysis || analysis.state === 'eliminada') {
      return NextResponse.json({ ok: false, error: 'Analysis not found.' }, { status: 404 });
    }
    const body = (await req.json().catch(() => ({}))) as { items?: unknown; path?: string; confirmed?: boolean };
    const items = Array.isArray(body.items) ? (body.items as SourcedItem[]) : null;
    if (!items || items.length === 0) {
      return NextResponse.json({ ok: false, error: 'A extração não pode ficar vazia.' }, { status: 400 });
    }

    const order = lineageOrder(analysisId, body.path);
    const previous = currentExtraction(analysisId, order);
    if (!previous) return NextResponse.json({ ok: false, error: 'Ainda não existe uma extração.' }, { status: 409 });

    // §13: an edit that removes an obligation, drops or changes a deadline, deletes a
    // reference, excludes a used source, turns a documented fact into a recommendation or
    // rewrites sourced content needs an explicit confirmation. The app decides this by
    // diffing the artifact — it never asks whoever made the edit to self-assess it.
    const impact = crossCheckExtractionEdit(
      extractionItems(previous.extractionId).map((i) => i.payload),
      items,
    );
    if (impact.gate && body.confirmed !== true) {
      return NextResponse.json({ ok: false, needsConfirmation: true, reasons: impact.reasons }, { status: 200 });
    }

    const extraction = storeExtraction({
      analysisId,
      pathLetter: order[0],
      kind: analysis.type === 'revision' ? 'matrix_line' : 'statement',
      items,
      origin: 'manual',
      // An edit inherits the fields the extraction it edits was made with — editing an item
      // must never silently re-shape it to whatever the template says today.
      fields: previous.fields,
      note: `Editada na aplicação a partir de ${previous.label}.`,
      confirmedDocumentIds: new Set(confirmedDocumentIds(analysisId)),
    });
    recordEvent(analysisId, 'extraction_edited', {
      extractionId: extraction.extractionId,
      from: previous.extractionId,
      accepted: extraction.acceptedCount,
      rejected: extraction.rejectedCount,
      confirmedReasons: impact.reasons,
    });
    return NextResponse.json({ ok: true, extraction, items: extractionItems(extraction.extractionId) });
  } catch (error) {
    return jsonError(error);
  }
}
