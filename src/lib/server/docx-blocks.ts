import PizZip from 'pizzip';

/**
 * A Word template, as a list of blocks.
 *
 * The two built-in templates were always composed from a tiny vocabulary — a styled
 * paragraph, a loop, and a table with a shaded header row over a repeated body row — but that
 * vocabulary lived in a build script, so the only thing the app held was the .docx it
 * produced. Editing then meant editing Word XML, where a stray change silently drops a
 * `{placeholder}` and every document generated afterwards comes out wrong.
 *
 * Holding the block list instead makes the edits the client actually asked for — change a
 * section, add one, remove one, reorder — ordinary operations on an array, and keeps
 * placeholders as block properties rather than as text anyone can mangle.
 */

export type ParagraphStyle = 'Normal' | 'Title' | 'Subtitle' | 'Heading1' | 'Small' | 'Cell' | 'CellHead';

export type TemplateBlock =
  | { type: 'paragraph'; text: string; style?: ParagraphStyle }
  /** A docxtemplater paragraph loop: `{#name}` … `{/name}` around its own blocks. */
  | { type: 'loop'; name: string; blocks: TemplateBlock[] }
  | {
      type: 'table';
      /** The docxtemplater row loop, opened in the first body cell and closed in the last. */
      rowLoop: string;
      columns: Array<{ header: string; cell: string; width: number }>;
    };

export type TemplateDoc = { blocks: TemplateBlock[] };

/** The image in the page header. Pixel size is the ASPECT RATIO source, never the print size. */
export type Letterhead = { bytes: Buffer; extension: 'jpeg' | 'png'; px: { w: number; h: number } };

const twips = (mm: number) => Math.round((mm * 1440) / 25.4);
const emu = (mm: number) => Math.round(mm * 36000);

/**
 * The letterhead box, measured on CÓDIGO DE CONDUTA — the client's own official document.
 *
 * A replacement image is fitted INSIDE this box at its own aspect ratio: a wider mark takes
 * the full width and less height, a taller one the full height and less width. It is never
 * stretched to fill the box, because a logo distorted to fit is worse than a small one.
 */
export const LOGO_BOX_MM = { w: 25.4, h: (25.4 * 572) / 605 };

/** Page top to the top of the mark: 19 mm. */
const HEADER_TWIPS = twips(19);
// In the reference the mark stops 36.4 mm short of the page edge, while its body text stops
// at 33 mm — the logo sits deliberately inside the text margin, it is not flush with it. Our
// pages keep a 25 mm right margin, so the header paragraph carries the remaining indent.
const LOGO_RIGHT_INDENT_TWIPS = twips(36.4 - 25);
/** The mark ends at 42.7 mm; the reference starts its body text at 46 mm. */
const TOP_MARGIN_TWIPS = twips(46);

/** Scale to fit within the box, keeping the aspect ratio — the larger overflow decides. */
export function letterheadExtent(px: { w: number; h: number }): { cx: number; cy: number } {
  const scale = Math.min(LOGO_BOX_MM.w / px.w, LOGO_BOX_MM.h / px.h);
  return { cx: emu(px.w * scale), cy: emu(px.h * scale) };
}

/** One fixed timestamp for every zip entry, so identical input yields identical bytes. */
const EPOCH = new Date('2026-01-01T00:00:00Z');

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const p = (text: string, style = '') =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;

// Readability: fixed layout with explicit column widths (long legal text wraps instead of
// squeezing columns), compact 9pt cell type, real cell padding, top alignment, and header
// rows that repeat on every page.
const cell = (text: string, opts: { width?: number; shaded?: boolean; style?: string } = {}) =>
  `<w:tc><w:tcPr>${opts.width ? `<w:tcW w:w="${opts.width}" w:type="dxa"/>` : ''}` +
  `${opts.shaded ? '<w:shd w:val="clear" w:color="auto" w:fill="DDE3EE"/>' : ''}` +
  `<w:vAlign w:val="top"/></w:tcPr>${p(text, opts.style || (opts.shaded ? 'CellHead' : 'Cell'))}</w:tc>`;

const row = (cells: string, opts: { header?: boolean } = {}) =>
  `<w:tr>${opts.header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`;

// widths: dxa column widths summing to ~9072 (A4 minus margins)
const table = (rows: string, widths: number[] = []) =>
  `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="9072" w:type="dxa"/><w:tblLayout w:type="fixed"/>` +
  `<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar>` +
  `<w:tblBorders>` +
  ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="B9C2D0"/>`)
    .join('') +
  `</w:tblBorders></w:tblPr>` +
  (widths.length ? `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>` : '') +
  `${rows}</w:tbl>`;

function blockXml(block: TemplateBlock): string {
  switch (block.type) {
    case 'paragraph':
      return p(block.text, block.style && block.style !== 'Normal' ? block.style : '');
    case 'loop':
      return [p(`{#${block.name}}`), ...block.blocks.map(blockXml), p(`{/${block.name}}`)].join('\n');
    case 'table': {
      const widths = block.columns.map((c) => c.width);
      const head = row(
        block.columns.map((c) => cell(c.header, { shaded: true, width: c.width })).join(''),
        { header: true },
      );
      const last = block.columns.length - 1;
      const body = row(
        block.columns
          .map((c, i) => {
            const open = i === 0 ? `{#${block.rowLoop}}` : '';
            const close = i === last ? `{/${block.rowLoop}}` : '';
            return cell(`${open}${c.cell}${close}`, { width: c.width });
          })
          .join(''),
      );
      return table(head + body, widths);
    }
  }
}

/** Every `{placeholder}` and `{#loop}` a document rendered from these blocks will need. */
export function placeholdersOf(doc: TemplateDoc): string[] {
  const found = new Set<string>();
  const walk = (blocks: TemplateBlock[]) => {
    for (const block of blocks) {
      if (block.type === 'paragraph') {
        for (const m of block.text.matchAll(/\{([#/]?)([a-z_][a-z0-9_]*)\}/gi)) found.add(m[2]);
      } else if (block.type === 'loop') {
        found.add(block.name);
        walk(block.blocks);
      } else {
        found.add(block.rowLoop);
        for (const column of block.columns) {
          for (const m of column.cell.matchAll(/\{([#/]?)([a-z_][a-z0-9_]*)\}/gi)) found.add(m[2]);
        }
      }
    }
  };
  walk(doc.blocks);
  return [...found].sort();
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
  <w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/><w:color w:val="1F3864"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/>
    <w:rPr><w:sz w:val="26"/><w:color w:val="444444"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="1F3864"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Small"><w:name w:val="Small"/><w:basedOn w:val="Normal"/>
    <w:rPr><w:sz w:val="18"/><w:color w:val="666666"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Cell"><w:name w:val="Cell"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="40" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="CellHead"><w:name w:val="CellHead"/><w:basedOn w:val="Cell"/>
    <w:rPr><w:b/><w:color w:val="1F3864"/></w:rPr></w:style>
  <w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>
</w:styles>`;

function headerXml(logo: Letterhead): string {
  const { cx, cy } = letterheadExtent(logo.px);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
       xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:p><w:pPr><w:jc w:val="right"/><w:spacing w:after="0"/><w:ind w:right="${LOGO_RIGHT_INDENT_TWIPS}"/></w:pPr><w:r><w:drawing>
    <wp:inline distT="0" distB="0" distL="0" distR="0">
      <wp:extent cx="${cx}" cy="${cy}"/>
      <wp:docPr id="1" name="Logotipo Grupo Barraqueiro" descr="Grupo Barraqueiro"/>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic>
          <pic:nvPicPr><pic:cNvPr id="1" name="Logotipo Grupo Barraqueiro"/><pic:cNvPicPr/></pic:nvPicPr>
          <pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
          <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
        </pic:pic>
      </a:graphicData></a:graphic>
    </wp:inline>
  </w:drawing></w:r></w:p>
</w:hdr>`;
}

/**
 * The .docx a block list renders to. Deterministic: same blocks + same logo, same bytes.
 *
 * Determinism is load-bearing here, not tidiness. The registry versions a template by the
 * hash of its file, so bytes that move on their own would mint a new version every time the
 * app rendered one. PizZip stamps each entry with the wall clock unless told otherwise —
 * which is why the build script this replaced produced different bytes depending on which
 * two-second window it ran in — so every entry is written with one fixed date.
 */
export function buildTemplateDocx(doc: TemplateDoc, logo: Letterhead): Buffer {
  const bodyXml = doc.blocks.map(blockXml).join('\n');
  const zip = new PizZip();
  const at = { date: EPOCH };
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Default Extension="${logo.extension}" ContentType="image/${logo.extension}"/>
</Types>`,
    at,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    at,
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
</Relationships>`,
    at,
  );
  zip.file('word/styles.xml', STYLES, at);
  zip.file('word/header1.xml', headerXml(logo), at);
  zip.file(
    'word/_rels/header1.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logotipo.${logo.extension}"/>
</Relationships>`,
    at,
  );
  zip.file(`word/media/logotipo.${logo.extension}`, logo.bytes, at);
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>
${bodyXml}
<w:sectPr><w:headerReference w:type="default" r:id="rId2"/><w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="${TOP_MARGIN_TWIPS}" w:right="1417" w:bottom="1417" w:left="1417" w:header="${HEADER_TWIPS}"/></w:sectPr>
</w:body></w:document>`,
    at,
  );
  // Deterministic bytes: fixed date, so an unchanged template never looks like a new version.
  // `date` is absent from PizZip's option typings but honoured by its writer — it is what
  // makes an unchanged template hash the same on every boot instead of looking edited.
  return zip.generate({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    date: EPOCH,
  } as PizZip.GenerateOptions & { type: 'nodebuffer' });
}
