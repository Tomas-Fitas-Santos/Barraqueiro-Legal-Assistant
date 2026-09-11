// A minimal PDF writer.
//
// The app has to produce a PDF for anything that is not one already, because pages,
// excerpts and citations are all defined on a PDF: give every accepted format a PDF
// rendition and preview, page numbers, the citation validators and the OCR stage all keep
// working untouched. That is one small writer against a native image toolchain in the
// container — ImageMagick alone would be ~100 MB on a ~200 MB image, for this.
//
// Offsets are computed over BUFFERS, not strings: an image stream is binary, and a
// latin1 round-trip would put the xref table at the wrong byte.

// ASCII on purpose. This is a machine-readable marker (it is how a test tells a rendition
// the app built from one a service produced), and the file is assembled as latin1 bytes —
// an accent here would be written mangled rather than merely looking odd.
const ENCODING_PRODUCER = 'Assistente Juridico';

/** Escape a string for a PDF literal — the three characters that end or nest one. */
export function pdfString(value: string): string {
  return value.replace(/[\\()]/g, (c) => `\\${c}`);
}

/** A stream object: its dictionary, then the raw bytes, length filled in for you. */
export function pdfStream(dict: string, data: Buffer): Buffer {
  const open = Buffer.from(`<<${dict}/Length ${data.length}>>\nstream\n`, 'latin1');
  const close = Buffer.from('\nendstream', 'latin1');
  return Buffer.concat([open, data, close]);
}

/**
 * Assemble numbered objects into a file. `objects[i]` is the body of object `i + 1` — the
 * caller writes `<<...>>` or a stream and never thinks about offsets or the trailer.
 */
export function buildPdf(objects: Buffer[], options?: { producer?: string }): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let at = parts[0].length;

  const infoIndex = objects.length + 1;
  const producer = options?.producer ? `${ENCODING_PRODUCER} - ${ascii(options.producer)}` : ENCODING_PRODUCER;
  const all = [...objects, Buffer.from(`<</Producer (${pdfString(producer)})>>`, 'latin1')];

  all.forEach((body, index) => {
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    offsets.push(at);
    parts.push(chunk);
    at += chunk.length;
  });

  const xrefAt = at;
  const xref = [
    `xref\n0 ${all.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
    `trailer\n<</Size ${all.length + 1}/Root 1 0 R/Info ${infoIndex} 0 R>>\nstartxref\n${xrefAt}\n%%EOF`,
  ].join('');
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

export type PageSpec = {
  /** Page size in PDF points (1/72 inch). */
  width: number;
  height: number;
  /** The page's content stream. */
  content: Buffer;
  /** Extra entries for the page's /Resources dictionary. */
  resources: string;
};

/**
 * The common shape: a catalogue, a page tree, and N pages that share one resource layout.
 * Object numbering is 1 = catalogue, 2 = pages, then each page followed by its content and
 * any extra objects the caller supplied.
 */
export function buildPagedPdf(pages: PageSpec[], extraObjects: Buffer[] = [], producer?: string): Buffer {
  // Layout: 1 catalogue, 2 page tree, then per page [page, content], then the extras.
  const firstPageObject = 3;
  const kids = pages.map((_, i) => `${firstPageObject + i * 2} 0 R`).join(' ');

  const objects: Buffer[] = [
    Buffer.from('<</Type/Catalog/Pages 2 0 R>>', 'latin1'),
    Buffer.from(`<</Type/Pages/Kids[${kids}]/Count ${pages.length}>>`, 'latin1'),
  ];
  pages.forEach((page, i) => {
    const contentRef = firstPageObject + i * 2 + 1;
    objects.push(
      Buffer.from(
        `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${round(page.width)} ${round(page.height)}]` +
          `/Contents ${contentRef} 0 R/Resources<<${page.resources}>>>>`,
        'latin1',
      ),
    );
    objects.push(pdfStream('', page.content));
  });
  objects.push(...extraObjects);
  return buildPdf(objects, { producer });
}

/**
 * The object number an extra will get, so a page's /Resources can point at it before it
 * exists. Layout is fixed: 1 catalogue, 2 page tree, then two objects per page.
 */
export function extraObjectNumber(pageCount: number, extraIndex: number): number {
  return 3 + pageCount * 2 + extraIndex;
}

function ascii(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '');
}

/** PDF numbers: enough precision to place things, not enough to bloat the file. */
export function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/\.?0+$/, '');
}
