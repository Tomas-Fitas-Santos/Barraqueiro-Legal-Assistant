import { ApiError, jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import {
  analysisTypeOfExtractionTemplate,
  buildExtractionTemplateJsonFrom,
  validateFields,
  type ExtractionField,
} from '@/lib/server/repo/extraction-template';

/**
 * A draft field list, shown as the specimen it publishes.
 *
 * Validated but not saved: the citation spine cannot be edited away, so a draft that removes
 * it is refused here exactly as it would be on save — the preview must not draw a template
 * that could never exist.
 */
export async function POST(req: Request, ctx: { params: Promise<{ templateId: string }> }) {
  try {
    await requireSession();
    const { templateId } = await ctx.params;
    const type = analysisTypeOfExtractionTemplate(templateId);
    if (!type) throw new ApiError('Template desconhecido.', 404);

    const body = (await req.json()) as { fields?: unknown };
    if (!Array.isArray(body.fields)) throw new ApiError('Campos em falta.', 400);

    const fields = validateFields(type, body.fields as ExtractionField[]);
    return new Response(new Uint8Array(buildExtractionTemplateJsonFrom(type, fields)), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
