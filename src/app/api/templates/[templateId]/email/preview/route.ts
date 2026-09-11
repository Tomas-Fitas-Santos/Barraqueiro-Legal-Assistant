import { NextResponse } from 'next/server';

import { ApiError, withSession } from '@/app/api/_helpers';
import { parseEmail } from '@/lib/server/ingest/email';
import { BUILTIN_EMAIL_TEMPLATES, buildEmailTemplateEmlFrom } from '@/lib/server/repo/template-blocks';

/**
 * A draft subject and body, shown as the message they make.
 *
 * The draft is built into the same `.eml` a save would publish and then read back with the
 * ingest parser — the parser the app uses on every e-mail it takes in. Rendering the two
 * fields directly would be simpler and would prove nothing; going through the round trip is
 * what makes the preview evidence that the file is well-formed, and it is the standing rule
 * that an e-mail preview is parsed server-side rather than guessed at in the browser.
 *
 * Writes nothing. The saved template is untouched.
 */
export async function POST(req: Request, ctx: { params: Promise<{ templateId: string }> }) {
  return withSession(async () => {
    const { templateId } = await ctx.params;
    if (!BUILTIN_EMAIL_TEMPLATES[templateId]) throw new ApiError('Template desconhecido.', 404);

    const body = (await req.json()) as { subject?: unknown; body?: unknown };
    if (typeof body.subject !== 'string' || typeof body.body !== 'string') {
      throw new ApiError('Assunto ou mensagem em falta.', 400);
    }

    const eml = buildEmailTemplateEmlFrom({ subject: body.subject, body: body.body });
    const email = await parseEmail(eml, 'email_eml');
    return NextResponse.json({
      ok: true,
      email: {
        from: email.from,
        to: email.to,
        cc: email.cc,
        date: email.date ? String(email.date) : '',
        subject: email.subject,
        bodyText: email.bodyText,
        attachments: [],
      },
    });
  });
}
