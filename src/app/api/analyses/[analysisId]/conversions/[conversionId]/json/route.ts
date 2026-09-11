import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { readConversionJson } from '@/lib/server/repo/conversions';

// The analysis as data: every extracted statement with its citation and its accept/reject
// decision. The same file that is written into the analysis's folder on OneDrive.
export async function GET(_req: Request, ctx: { params: Promise<{ analysisId: string; conversionId: string }> }) {
  try {
    await requireSession();
    const { analysisId, conversionId } = await ctx.params;
    const { conversion, bytes } = readConversionJson(analysisId, conversionId);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${conversion.jsonFilename}"`,
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
