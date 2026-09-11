import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { applyTrackBack, getAnalysis } from '@/lib/server/repo/analyses';
import { stageFor, stagesFor } from '@/lib/server/stages';

// GET: the deterministic prompt for a stage (what the agent asks before redoing it).
export async function GET(req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    await requireSession();
    const { analysisId } = await ctx.params;
    const analysis = getAnalysis(analysisId);
    if (!analysis) return NextResponse.json({ ok: false, error: 'Analysis not found.' }, { status: 404 });
    const key = new URL(req.url).searchParams.get('stage') || '';
    if (!key) return NextResponse.json({ ok: true, stages: stagesFor(analysis.type) });
    const stage = stageFor(analysis.type, key);
    if (!stage) return NextResponse.json({ ok: false, error: 'Unknown stage.' }, { status: 404 });
    return NextResponse.json({ ok: true, stage });
  } catch (error) {
    return jsonError(error);
  }
}

// POST: apply the track-back — fork the path, store the guidance, restart from the stage.
export async function POST(req: Request, ctx: { params: Promise<{ analysisId: string }> }) {
  try {
    await requireSession();
    const { analysisId } = await ctx.params;
    const analysis = getAnalysis(analysisId);
    if (!analysis) return NextResponse.json({ ok: false, error: 'Analysis not found.' }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const stage = stageFor(analysis.type, String(body.stage || ''));
    if (!stage) return NextResponse.json({ ok: false, error: 'Unknown stage.' }, { status: 400 });
    const guidance = String(body.guidance || '').trim();
    if (!guidance) return NextResponse.json({ ok: false, error: 'A resposta é obrigatória.' }, { status: 400 });

    const result = applyTrackBack(analysisId, stage.key, guidance, stage.restart);
    return NextResponse.json({ ok: true, ...result, restart: stage.restart, stage: stage.key });
  } catch (error) {
    return jsonError(error);
  }
}
