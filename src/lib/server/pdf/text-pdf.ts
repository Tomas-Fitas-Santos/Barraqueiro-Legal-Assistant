import { buildPagedPdf, extraObjectNumber, pdfString, round } from '@/lib/server/pdf/writer';

// Text, typeset onto pages.
//
// The important part is the return value: this hands back the EXACT text of each page
// alongside the PDF. When the app generated the document it already knows what is on every
// page, so there is no reason to write a PDF and then read it back with pdf.js — a round
// trip that can only lose fidelity, and that would send a short e-mail to a vision model to
// "transcribe" text this app wrote itself. A citation excerpt is therefore byte-identical to
// what the viewer shows.

const PAGE_W = 595; // A4 at 72 dpi
const PAGE_H = 842;
const MARGIN = 56;
const FONT_SIZE = 10;
const LEADING = 13;
const LINES_PER_PAGE = Math.floor((PAGE_H - MARGIN * 2) / LEADING);
/** Helvetica at 10pt: ~0.5em average, so this many characters fit between the margins. */
const CHARS_PER_LINE = Math.floor((PAGE_W - MARGIN * 2) / (FONT_SIZE * 0.5));

export type TextPdfResult = { pdf: Buffer; pages: string[]; note: string };

export function textToPdf(text: string): TextPdfResult {
  const { lines, replaced } = layout(text);
  const pageLines: string[][] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
    pageLines.push(lines.slice(i, i + LINES_PER_PAGE));
  }
  if (pageLines.length === 0) pageLines.push(['']);

  const fontRef = extraObjectNumber(pageLines.length, 0);
  const pages = pageLines.map((linesOnPage) => ({
    width: PAGE_W,
    height: PAGE_H,
    content: contentStream(linesOnPage),
    resources: `/Font<</F1 ${fontRef} 0 R>>`,
  }));
  const font = Buffer.from('<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>', 'latin1');

  return {
    pdf: buildPagedPdf(pages, [font], 'e-mail'),
    pages: pageLines.map((linesOnPage) => linesOnPage.join('\n')),
    note: replaced
      ? 'Alguns caracteres do original não são representáveis no PDF (substituídos por "?").'
      : '',
  };
}

function contentStream(lines: string[]): Buffer {
  const body = lines
    .map((line, i) => `1 0 0 1 ${MARGIN} ${round(PAGE_H - MARGIN - (i + 1) * LEADING)} Tm (${pdfString(line)}) Tj`)
    .join('\n');
  return Buffer.from(`BT /F1 ${FONT_SIZE} Tf ${LEADING} TL\n${body}\nET`, 'latin1');
}

/**
 * The characters WinAnsi has and Latin-1 does not.
 *
 * The content stream is written as latin1, so a code point above U+00FF is truncated to its
 * low byte — which is why declaring WinAnsiEncoding was not enough on its own: an em dash
 * and a curly quote came out as "?", and the euro sign came out as "¬". These are exactly
 * the characters real prose is full of, so every e-mail preview and every rendered export
 * was pockmarked with them. Mapping each to the BYTE WinAnsi puts it at makes them print.
 */
const WIN_ANSI_HIGH: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88,
  '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '\u2018': 0x91, '\u2019': 0x92,
  '\u201c': 0x93, '\u201d': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99,
  'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};

/**
 * Wrap to the page width, keeping the author's own line breaks. Standard-14 Helvetica with
 * WinAnsi covers every pt-PT glyph (ç ã õ á é ê í ó ú à), the punctuation above, and €;
 * anything else becomes "?" and is reported rather than silently dropped.
 */
function layout(text: string): { lines: string[]; replaced: boolean } {
  let replaced = false;
  const toWinAnsi = (value: string) =>
    value.replace(/[^\x20-\x7E\xA0-\xFF]/g, (c) => {
      if (c === '\t') return '    ';
      const byte = WIN_ANSI_HIGH[c];
      if (byte !== undefined) return String.fromCharCode(byte);
      replaced = true;
      return '?';
    });

  const lines: string[] = [];
  for (const rawLine of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = toWinAnsi(rawLine);
    if (line.length <= CHARS_PER_LINE) {
      lines.push(line);
      continue;
    }
    let current = '';
    for (const word of line.split(' ')) {
      if (!current) {
        current = word;
      } else if (`${current} ${word}`.length <= CHARS_PER_LINE) {
        current = `${current} ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
      // A single word longer than the line (a URL, a long filename) is cut, not lost.
      while (current.length > CHARS_PER_LINE) {
        lines.push(current.slice(0, CHARS_PER_LINE));
        current = current.slice(CHARS_PER_LINE);
      }
    }
    lines.push(current);
  }
  return { lines, replaced };
}
