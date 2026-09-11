import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { dismissLibraryMove, pendingLibraryMove, transferLibrary } from '@/lib/server/repo/library';

// The only question a library move asks: bring the documents across, or leave them behind.
// Everything else about a move — the folder structure, the caches, the delta cursor — the
// app settles by itself.

export async function GET() {
  return withSession(async () => NextResponse.json({ ok: true, move: pendingLibraryMove() }));
}

export async function POST(req: Request) {
  return withSession(async () => {
    const move = pendingLibraryMove();
    if (!move) return NextResponse.json({ ok: false, error: 'Não há documentos por transferir.' }, { status: 400 });

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.decision === 'skip') {
      // Leaving them behind is a decision with consequences the user has to have seen, so
      // the confirmation names the counts rather than being a bare yes.
      if (Number(body.confirmDocumentCount) !== move.documentCount) {
        return NextResponse.json(
          { ok: false, error: 'Confirmação não corresponde ao número de documentos.' },
          { status: 409 },
        );
      }
      dismissLibraryMove();
      return NextResponse.json({ ok: true, decision: 'skip' });
    }

    const report = await transferLibrary();
    return NextResponse.json({ ok: true, decision: 'transfer', report });
  });
}
