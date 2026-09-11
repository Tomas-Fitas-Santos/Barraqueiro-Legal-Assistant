import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import {
  catalogueCoversAppModels,
  extraCatalogueEntries,
  modelRows,
  storedCatalogue,
} from '@/lib/server/ai/catalogue';
import { MODEL_SETTING_KEY, selectedModel } from '@/lib/server/ai/client';
import { setSetting } from '@/lib/server/db';
import { AI_MODELS, isAiModel } from '@/lib/types';

export async function GET() {
  return withSession(async () => {
    const selected = selectedModel();
    const catalogue = storedCatalogue();
    return NextResponse.json({
      ok: true,
      models: AI_MODELS,
      selected,
      rows: modelRows(selected),
      extras: extraCatalogueEntries(),
      comparable: catalogueCoversAppModels(),
      catalogue: catalogue ? { fetchedAt: catalogue.fetchedAt, source: catalogue.source } : null,
    });
  });
}

export async function PATCH(req: Request) {
  return withSession(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const model = String(body.model || '').trim();
    if (!isAiModel(model)) {
      return NextResponse.json({ ok: false, error: 'Unknown model.' }, { status: 400 });
    }
    setSetting(MODEL_SETTING_KEY, model);
    return NextResponse.json({ ok: true, selected: model });
  });
}
