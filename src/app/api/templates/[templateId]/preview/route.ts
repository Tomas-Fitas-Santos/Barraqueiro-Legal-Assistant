import { ApiError, jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import type { TemplateDoc } from '@/lib/server/docx-blocks';
import { BUILTIN_TEMPLATE_BLOCKS, renderTemplateDraft } from '@/lib/server/repo/template-blocks';

/**
 * What a block list would look like as a document, before anything is written down.
 *
 * The editor used to preview the PUBLISHED file, which meant the only way to see the effect
 * of an edit was `Guardar e publicar` — minting a template version and replacing the copy on
 * the client's OneDrive. The feedback loop ran through the client's live drive, so looking
 * cost as much as deciding.
 *
 * This renders instead. It writes NOTHING: no saved blocks, no seeding, no publish, no
 * library row — a preview never adds to the library. The bytes come from the same
 * `renderTemplateDraft` the publish path uses, so what is previewed is what would be
 * published, and the renderer is deterministic, so identical blocks give identical bytes.
 *
 * A missing required placeholder is NOT refused here. Losing one is confirmed at the moment
 * it becomes permanent, on PUT; refusing to draw it would hide the very change the person is
 * trying to look at before deciding.
 */
export async function POST(req: Request, ctx: { params: Promise<{ templateId: string }> }) {
  try {
    await requireSession();
    const { templateId } = await ctx.params;
    if (!BUILTIN_TEMPLATE_BLOCKS[templateId]) throw new ApiError('Template desconhecido.', 404);

    const body = (await req.json()) as { blocks?: unknown };
    if (!Array.isArray(body.blocks)) throw new ApiError('Blocos em falta.', 400);

    const bytes = renderTemplateDraft({ blocks: body.blocks } as TemplateDoc);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
