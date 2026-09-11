import { existsSync, readFileSync } from 'node:fs';

import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { getDb } from '@/lib/server/db';
import { parseEmail } from '@/lib/server/ingest/email';
import { originalPath } from '@/lib/server/ingest/pipeline';
import { getDocument } from '@/lib/server/repo/library';

// An e-mail, as an e-mail. The preview used to show one as a PDF of a text rendering of it,
// which put two conversions between the reader and the thing they were checking — usually
// who it was addressed to, or whether an attachment is really there.
//
// Parsing stays on the server: MIME is not something to re-implement in the browser, and
// the parser that reads an .eml into the library is the one whose answer the preview should
// show — otherwise the preview and the ingest could disagree about the same file.
export async function GET(_req: Request, ctx: { params: Promise<{ documentId: string }> }) {
  try {
    await requireSession();
    const { documentId } = await ctx.params;
    const doc = getDocument(documentId);
    if (!doc) return NextResponse.json({ ok: false, error: 'Document not found.' }, { status: 404 });

    const row = getDb().prepare('SELECT sha256 FROM documents WHERE document_id = ?').get(documentId) as
      | { sha256: string }
      | undefined;
    const file = row?.sha256 ? originalPath(row.sha256) : '';
    if (!file || !existsSync(file)) {
      return NextResponse.json({ ok: false, error: 'O ficheiro ainda não está disponível.' }, { status: 409 });
    }

    const kind = /\.msg$/i.test(doc.name) ? 'email_msg' : 'email_eml';
    const email = await parseEmail(readFileSync(file), kind);
    return NextResponse.json({
      ok: true,
      email: {
        from: email.from,
        to: email.to,
        cc: email.cc,
        date: email.date,
        subject: email.subject,
        bodyText: email.bodyText,
        attachments: email.attachments.map((a) => ({ name: a.filename, mime: a.mimeType, size: a.bytes.length, inline: a.inline })),
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
