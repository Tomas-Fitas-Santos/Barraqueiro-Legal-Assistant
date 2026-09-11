import { NextResponse } from 'next/server';

import { ApiError, withSession } from '@/app/api/_helpers';
import { LOGO_BOX_MM, letterheadExtent } from '@/lib/server/docx-blocks';
import {
  currentLetterhead,
  MAX_LOGO_BYTES,
  resetLetterhead,
  setLetterhead,
  usingDefaultLetterhead,
} from '@/lib/server/repo/template-blocks';
import { publishBuiltinTemplates, seedTemplates } from '@/lib/server/repo/templates';

/**
 * The mark in the page header of every generated document.
 *
 * A replacement is fitted into the box the current logo occupies, at its own aspect ratio —
 * scaled up or down as a whole, never stretched to fill. Changing it re-renders and
 * re-publishes both built-in templates, because the logo is part of what they are.
 */

function describe() {
  const logo = currentLetterhead();
  const { cx, cy } = letterheadExtent(logo.px);
  return {
    isDefault: usingDefaultLetterhead(),
    extension: logo.extension,
    px: logo.px,
    /** Where it will actually print, in mm, inside the fixed box. */
    printedMm: { w: Math.round((cx / 36000) * 10) / 10, h: Math.round((cy / 36000) * 10) / 10 },
    boxMm: { w: Math.round(LOGO_BOX_MM.w * 10) / 10, h: Math.round(LOGO_BOX_MM.h * 10) / 10 },
    maxBytes: MAX_LOGO_BYTES,
  };
}

export async function GET() {
  return withSession(async () => NextResponse.json({ ok: true, logo: describe() }));
}

/** The image itself, so the settings page can show what is in force. */
export async function POST(req: Request) {
  return withSession(async () => {
    const bytes = Buffer.from(await req.arrayBuffer());
    if (!bytes.length) throw new ApiError('Nenhuma imagem recebida.', 400);
    setLetterhead(bytes);
    seedTemplates();
    await publishBuiltinTemplates();
    return NextResponse.json({ ok: true, logo: describe() });
  });
}

export async function DELETE() {
  return withSession(async () => {
    resetLetterhead();
    seedTemplates();
    await publishBuiltinTemplates();
    return NextResponse.json({ ok: true, logo: describe() });
  });
}
