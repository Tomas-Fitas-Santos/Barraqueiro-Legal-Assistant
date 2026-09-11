import { NextResponse } from 'next/server';

import { ApiError, withSession } from '@/app/api/_helpers';
import {
  BUILTIN_EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_FIELDS,
  emailTemplate,
  isEmailEdited,
  revertEmailTemplate,
  saveEmailTemplate,
} from '@/lib/server/repo/template-blocks';
import { emailTemplateName, publishBuiltinTemplates, publishedTemplateDocumentId, seedTemplates } from '@/lib/server/repo/templates';

/** The subject and body of the message that delivers an approved PDF. */

function requireEmailTemplate(templateId: string) {
  if (!BUILTIN_EMAIL_TEMPLATES[templateId]) throw new ApiError('Template desconhecido.', 404);
}


export async function GET(_req: Request, ctx: { params: Promise<{ templateId: string }> }) {
  return withSession(async () => {
    const { templateId } = await ctx.params;
    requireEmailTemplate(templateId);
    const tpl = emailTemplate(templateId)!;
    return NextResponse.json({
      ok: true,
      templateId,
      name: emailTemplateName(templateId),
      subject: tpl.subject,
      body: tpl.body,
      edited: isEmailEdited(templateId),
      fields: EMAIL_TEMPLATE_FIELDS,
      documentId: publishedTemplateDocumentId(templateId),
    });
  });
}

export async function PUT(req: Request, ctx: { params: Promise<{ templateId: string }> }) {
  return withSession(async () => {
    const { templateId } = await ctx.params;
    requireEmailTemplate(templateId);
    const body = (await req.json()) as { subject?: string; body?: string };
    const subject = String(body.subject ?? '').slice(0, 500);
    const text = String(body.body ?? '').slice(0, 20000);
    if (!subject.trim()) throw new ApiError('O assunto não pode ficar vazio.', 400);
    saveEmailTemplate(templateId, { subject, body: text });
    seedTemplates();
    await publishBuiltinTemplates();
    return NextResponse.json({ ok: true });
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ templateId: string }> }) {
  return withSession(async () => {
    const { templateId } = await ctx.params;
    requireEmailTemplate(templateId);
    revertEmailTemplate(templateId);
    seedTemplates();
    await publishBuiltinTemplates();
    return NextResponse.json({ ok: true });
  });
}
