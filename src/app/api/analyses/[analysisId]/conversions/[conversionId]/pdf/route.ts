import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { readConversionPdf } from '@/lib/server/repo/conversions';

// PDF preview/download (§12 step 5) — served from the app's content-addressed copy.
export async function GET(_req: Request, ctx: { params: Promise<{ analysisId: string; conversionId: string }> }) {
  try {
    await requireSession();
    const { analysisId, conversionId } = await ctx.params;
    const { conversion, bytes } = readConversionPdf(analysisId, conversionId);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${conversion.pdfFilename}"`,
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
