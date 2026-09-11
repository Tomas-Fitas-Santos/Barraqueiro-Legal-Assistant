import { NextResponse } from 'next/server';

import { ApiError, withSession } from '@/app/api/_helpers';
import {
  analysisTypeOfExtractionTemplate,
  BUILTIN_EXTRACTION_FIELDS,
  type ExtractionField,
  extractionFields,
  isExtractionEdited,
  revertExtractionFields,
  saveExtractionFields,
} from '@/lib/server/repo/extraction-template';
import {
  extractionTemplateName,
  publishedTemplateDocumentId,
  publishBuiltinTemplates,
  seedTemplates,
} from '@/lib/server/repo/templates';

/** What the agent is asked to extract — the content fields, never the citation spine. */

function requireType(templateId: string) {
  const type = analysisTypeOfExtractionTemplate(templateId);
  if (!type) throw new ApiError('Template desconhecido.', 404);
  return type;
}


export async function GET(_req: Request, ctx: { params: Promise<{ templateId: string }> }) {
  return withSession(async () => {
    const { templateId } = await ctx.params;
    const type = requireType(templateId);
    return NextResponse.json({
      ok: true,
      templateId,
      name: extractionTemplateName(templateId),
      analysisType: type,
      fields: extractionFields(type),
      builtinKeys: BUILTIN_EXTRACTION_FIELDS[type].map((f) => f.key),
      edited: isExtractionEdited(type),
      documentId: publishedTemplateDocumentId(templateId),
    });
  });
}

export async function PUT(req: Request, ctx: { params: Promise<{ templateId: string }> }) {
  return withSession(async () => {
    const { templateId } = await ctx.params;
    const type = requireType(templateId);
    const body = (await req.json()) as { fields?: ExtractionField[] };
    const saved = saveExtractionFields(type, body.fields || []);
    seedTemplates();
    await publishBuiltinTemplates();
    return NextResponse.json({ ok: true, fields: saved });
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ templateId: string }> }) {
  return withSession(async () => {
    const { templateId } = await ctx.params;
    revertExtractionFields(requireType(templateId));
    seedTemplates();
    await publishBuiltinTemplates();
    return NextResponse.json({ ok: true });
  });
}
