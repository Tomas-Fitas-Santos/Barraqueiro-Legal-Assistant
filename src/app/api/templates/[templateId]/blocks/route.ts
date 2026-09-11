import { NextResponse } from 'next/server';

import { ApiError, withSession } from '@/app/api/_helpers';
import { placeholdersOf, type TemplateDoc } from '@/lib/server/docx-blocks';
import {
  BUILTIN_TEMPLATE_BLOCKS,
  isEdited,
  revertTemplateBlocks,
  saveTemplateBlocks,
  templateBlocks,
} from '@/lib/server/repo/template-blocks';
import {
  builtinTemplateName,
  publishedTemplateDocumentId,
  publishBuiltinTemplates,
  requiredFieldsOf,
  seedTemplates,
} from '@/lib/server/repo/templates';

/**
 * The blocks a built-in template is made of, and the client's edits to them.
 *
 * A template edited here is re-rendered and re-published: the registry mints a version from
 * the new bytes, and the copy in the library's Templates folder is replaced so what the
 * client sees on OneDrive is what the app will actually fill.
 */

function requireBuiltin(templateId: string) {
  if (!BUILTIN_TEMPLATE_BLOCKS[templateId]) throw new ApiError('Template desconhecido.', 404);
}


export async function GET(_req: Request, ctx: { params: Promise<{ templateId: string }> }) {
  return withSession(async () => {
    const { templateId } = await ctx.params;
    requireBuiltin(templateId);
    const doc = templateBlocks(templateId) as TemplateDoc;
    return NextResponse.json({
      ok: true,
      templateId,
      name: builtinTemplateName(templateId),
      blocks: doc.blocks,
      edited: isEdited(templateId),
      requiredFields: requiredFieldsOf(templateId),
      placeholders: placeholdersOf(doc),
      documentId: publishedTemplateDocumentId(templateId),
    });
  });
}

export async function PUT(req: Request, ctx: { params: Promise<{ templateId: string }> }) {
  return withSession(async () => {
    const { templateId } = await ctx.params;
    requireBuiltin(templateId);
    const body = (await req.json()) as { blocks?: unknown; confirm?: boolean };
    if (!Array.isArray(body.blocks)) throw new ApiError('Blocos em falta.', 400);
    const doc = { blocks: body.blocks } as TemplateDoc;

    // The consequential change to a template is not a reworded heading — it is a lost
    // placeholder, which breaks every document generated from then on without ever looking
    // broken here. So it is named and confirmed, rather than refused or waved through.
    const present = new Set(placeholdersOf(doc));
    const missing = requiredFieldsOf(templateId).filter((field) => !present.has(field));
    if (missing.length && !body.confirm) {
      return NextResponse.json({ ok: false, needsConfirmation: true, missing }, { status: 409 });
    }

    saveTemplateBlocks(templateId, doc);
    seedTemplates();
    await publishBuiltinTemplates();
    return NextResponse.json({ ok: true, missing });
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ templateId: string }> }) {
  return withSession(async () => {
    const { templateId } = await ctx.params;
    requireBuiltin(templateId);
    revertTemplateBlocks(templateId);
    seedTemplates();
    await publishBuiltinTemplates();
    return NextResponse.json({ ok: true });
  });
}
