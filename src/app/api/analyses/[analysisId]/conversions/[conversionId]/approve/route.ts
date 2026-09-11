import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { assertAction } from '@/lib/server/workflow';
import { approvePdf } from '@/lib/server/repo/conversions';
import { draftContent, saveDraftContent } from '@/lib/server/repo/email-draft';
import { recordEvent } from '@/lib/server/repo/analyses';

// §12 step 6: the human's visual approval of the PDF — a technically successful conversion
// is not proof that the pagination is right, which is why this gate is a person and not a
// test. Approving hands off: the draft is prepared and waiting in the E-mail phase.
export async function POST(_req: Request, ctx: { params: Promise<{ analysisId: string; conversionId: string }> }) {
  try {
    const session = await requireSession();
    const { analysisId, conversionId } = await ctx.params;
    // The definition decides whether this is allowed, and supplies the refusal.
    await assertAction(analysisId, 'approve_pdf');
    const conversion = approvePdf(analysisId, conversionId, session.email);

    // Persist the proposal so the e-mail is an artifact the user edits, not a template
    // regenerated on every read.
    saveDraftContent(analysisId, draftContent(analysisId), { silent: true });
    recordEvent(analysisId, 'email_draft_created', { pdfName: conversion.pdfFilename, prepared: true });

    return NextResponse.json({ ok: true, conversion });
  } catch (error) {
    return jsonError(error);
  }
}
