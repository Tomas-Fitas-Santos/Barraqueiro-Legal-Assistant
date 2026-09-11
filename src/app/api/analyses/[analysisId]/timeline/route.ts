import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import {
  getAnalysis,
  listAnalysisDocuments,
  listEvents,
  listItems,
} from '@/lib/server/repo/analyses';
import { listConversions } from '@/lib/server/repo/conversions';
import { currentExtraction, listExtractions } from '@/lib/server/repo/extractions';
import { draftContent, draftGate } from '@/lib/server/repo/email-draft';
import { listTurns } from '@/lib/server/repo/chat';
import { activePath, listPaths, listVersions } from '@/lib/server/repo/versions';
import { workflowStatus } from '@/lib/server/workflow';
import { addUserVoice } from '@/lib/workflow/conversation';
import { resolveFailures } from '@/lib/workflow/failures';

// The chat surface's single read: everything that happened, merged into one ordered feed,
// plus the current interactive state (documents to confirm, items to review, draft gate).
export async function GET(req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    await requireSession();
    const { analysisId } = await ctx.params;
    // ?path=b asks for that path's status; without it, the path being worked on.
    const path = new URL(req.url).searchParams.get('path') || undefined;
    const analysis = getAnalysis(analysisId);
    if (!analysis || analysis.state === 'eliminada') {
      return NextResponse.json({ ok: false, error: 'Analysis not found.' }, { status: 404 });
    }

    const versions = listVersions(analysisId);
    const conversions = listConversions(analysisId);
    const turns = listTurns(analysisId);
    const events = listEvents(analysisId);
    // Version/conversion/turn rows render as their own bubble types; events cover the rest
    // of the trail (the kinds already materialised above are skipped to avoid doubles).
    const MATERIALISED = new Set([
      'version_generated', 'version_uploaded_manual', 'chat_change_applied', 'chat_change_pending',
      'chat_change_confirmed', 'chat_change_discarded', 'pdf_converted',
    ]);
    // Every entry carries the PATH it belongs to, so the client never has to infer it:
    // events and turns are stamped at write time, versions own theirs, and a conversion
    // inherits the path of the version it converted.
    const pathOfVersion = new Map(versions.map((v) => [v.versionId, v.pathLetter]));
    const feed: Array<{ at: number; kind: string; pathLetter: string; data: Record<string, unknown> }> = [];
    for (const event of events) {
      if (MATERIALISED.has(event.kind)) continue;
      feed.push({ at: event.createdAt, kind: `event:${event.kind}`, pathLetter: event.pathLetter, data: event.detail });
    }
    for (const version of versions) {
      feed.push({ at: version.createdAt, kind: 'version', pathLetter: version.pathLetter, data: { ...version } });
    }
    for (const conversion of conversions) {
      feed.push({
        at: conversion.createdAt,
        kind: 'conversion',
        pathLetter: pathOfVersion.get(conversion.versionId) || 'a',
        data: { ...conversion },
      });
    }
    for (const turn of turns) {
      feed.push({ at: turn.createdAt, kind: 'turn', pathLetter: turn.pathLetter, data: { ...turn } });
    }
    // Every artifact the workflow produces is a feed entry, so the chat can show it where
    // it happened and open it at any later phase. Before this the extraction was reachable
    // only during Revisão and the PDF had no chronological presence at all.
    for (const extraction of listExtractions(analysisId)) {
      feed.push({
        at: extraction.createdAt,
        kind: 'extraction',
        pathLetter: extraction.pathLetter,
        data: { ...extraction },
      });
    }
    const gate = draftGate(analysisId);
    const emailPrepared = [...events].reverse().find((event) => event.kind === 'email_draft_created');
    if (emailPrepared) {
      const content = draftContent(analysisId);
      const approved = events.some((event) => event.kind === 'email_approved' && event.pathLetter === emailPrepared.pathLetter);
      feed.push({
        at: emailPrepared.createdAt,
        kind: 'email',
        pathLetter: emailPrepared.pathLetter,
        data: { ...content, attachment: gate.allowed ? gate.summary : null, approved },
      });
    }
    feed.sort((a, b) => a.at - b.at);
    // The chat is what is true NOW; `feed` is the record. Histórico renders the record and
    // keeps every attempt, so the two cannot be the same array.
    const chatFeed = addUserVoice(resolveFailures(feed));

    // The workflow status: which phase this path is in, what can be done, and what stops
    // it. The client renders this rather than deriving it a second time.
    const workflow = await workflowStatus(analysisId, path);
    return NextResponse.json({
      ok: true,
      analysis,
      workflow,
      feed,
      chatFeed,
      documents: listAnalysisDocuments(analysisId),
      items: listItems(analysisId),
      conversions,
      paths: listPaths(analysisId),
      activePath: activePath(analysisId),
      draft: gate.allowed ? { allowed: true, summary: gate.summary } : { allowed: false, reason: gate.reason },
    });
  } catch (error) {
    return jsonError(error);
  }
}
