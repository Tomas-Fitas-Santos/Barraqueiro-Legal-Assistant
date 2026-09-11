import { jsonError } from '@/app/api/_helpers';
import { requireSession } from '@/lib/server/auth';
import { currentLetterhead } from '@/lib/server/repo/template-blocks';

/** The letterhead image in force, so the editor can show the mark rather than describe it. */
export async function GET() {
  try {
    await requireSession();
    const logo = currentLetterhead();
    return new Response(new Uint8Array(logo.bytes), {
      headers: { 'Content-Type': `image/${logo.extension}`, 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
