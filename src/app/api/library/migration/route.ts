import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { planMigration, runMigration } from '@/lib/server/repo/library-migration';

// The legacy migration: what is still sitting outside "1. Documentos oficiais", and the
// request to move it there. GET is always safe — the plan is a read of current state.
export async function GET() {
  return withSession(async () => NextResponse.json({ ok: true, ...planMigration() }));
}

export async function POST(req: Request) {
  return withSession(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id)) : [];
    if (ids.length === 0) {
      return NextResponse.json({ ok: false, error: 'Nenhum item selecionado.' }, { status: 400 });
    }
    return NextResponse.json({ ok: true, ...(await runMigration(ids)) });
  });
}
