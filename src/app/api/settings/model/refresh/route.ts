import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import {
  catalogueCoversAppModels,
  extraCatalogueEntries,
  modelRows,
  refreshCatalogue,
} from '@/lib/server/ai/catalogue';
import { selectedModel } from '@/lib/server/ai/client';

// Pull the model catalogue from OpenAI and cache it. Explicit, never automatic: it is a
// network call against the user's own account, so it happens when they ask for it.
export async function POST() {
  return withSession(async () => {
    try {
      const catalogue = await refreshCatalogue();
      const selected = selectedModel();
      return NextResponse.json({
        ok: true,
        catalogue: { fetchedAt: catalogue.fetchedAt, source: catalogue.source },
        rows: modelRows(selected),
        extras: extraCatalogueEntries(),
        comparable: catalogueCoversAppModels(),
      });
    } catch (error) {
      // A failed refresh is information, not a crash: the table keeps what it had.
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ ok: false, error: message.slice(0, 300) }, { status: 200 });
    }
  });
}
