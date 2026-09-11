// §7.5 — reading a page's SHAPE, not just its characters.
//
// `extractText()` returns one flat string per page and throws away everything pdf.js already
// knows: where each run sits, how wide it is, what size it was set in. So a heading arrived
// indistinguishable from body text, a two-column table arrived as interleaved words, and the
// same footer arrived on all forty pages.
//
// That last one is not a cosmetic complaint. Repeated headers and footers are identical
// across every page of a document AND similar across every document from the same company,
// so leaving them in the segments inflates the measured similarity between documents that
// have nothing to do with each other — which is exactly the signal phase 9's semantic index
// is about to be built on. Stripping boilerplate is the reason this lands FIRST.
//
// Everything here is deterministic geometry. Nothing asks a model anything.

export type TextItem = {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
};

/** A run of text with no big horizontal gap inside it — a table cell, or a whole line. */
export type Cell = { text: string; x: number; endX: number };

export type Line = {
  text: string;
  cells: Cell[];
  y: number;
  /** Where the line's last character sits — how a wrapped line is told from a finished one. */
  endX: number;
  fontSize: number;
};

export type PageStructure = {
  text: string;
  headings: number;
  lists: number;
  tables: number;
};

export type DocumentStructure = {
  pages: string[];
  headings: number;
  lists: number;
  tables: number;
  /**
   * Always 'baixa' when a table was detected. The detector reads column boundaries and
   * nothing else: merged cells, wrapped cell text and nested tables need a real layout
   * model, and claiming a confidence this implementation has not earned is worse than
   * saying so.
   */
  tableConfidence: 'n/a' | 'baixa';
};

/** Two runs on the same visual line never differ in y by more than a fraction of their size. */
const LINE_TOLERANCE_RATIO = 0.4;
/** A horizontal gap this many times the font size starts a new cell — i.e. a column. */
const CELL_GAP_RATIO = 1.6;
/** Column starts within this many points of each other across rows count as one column. */
const COLUMN_ALIGN_TOLERANCE = 8;
const HEADING_RATIO = 1.15;
const MAJOR_HEADING_RATIO = 1.45;
const HEADING_MAX_CHARS = 120;
/** Bullet glyphs only. Legal enumerations ("3.", "a)", "i)") are TEXT and stay untouched. */
const BULLET = /^[\u2022\u25aa\u25e6\u2023\u00b7\u2043\u2219*]\s+/;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** The size most of the page's CHARACTERS are set in — not the most frequent run. */
function bodyFontSize(lines: Line[]): number {
  const weight = new Map<number, number>();
  for (const line of lines) {
    const size = Math.round(line.fontSize * 2) / 2;
    weight.set(size, (weight.get(size) || 0) + line.text.length);
  }
  let best = 0;
  let bestWeight = -1;
  for (const [size, chars] of weight) {
    if (chars > bestWeight) {
      best = size;
      bestWeight = chars;
    }
  }
  return best;
}

/**
 * Runs → lines → cells. Items arrive in content-stream order, which is reading order often
 * enough to be tempting and not often enough to rely on, so position decides both.
 */
export function buildLines(items: TextItem[]): Line[] {
  const positioned = items.filter((item) => item.width > 0 || item.str.trim());
  if (positioned.length === 0) return [];
  const sizes = positioned.map((item) => item.fontSize).filter((size) => size > 0);
  const tolerance = Math.max(1, median(sizes) * LINE_TOLERANCE_RATIO);

  const sorted = [...positioned].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: TextItem[][] = [];
  for (const item of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - item.y) <= tolerance) row.push(item);
    else rows.push([item]);
  }

  const lines: Line[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    const cells: Cell[] = [];
    let fontSize = 0;
    for (const item of row) {
      const size = item.fontSize || fontSize;
      fontSize = Math.max(fontSize, size);
      const piece = item.str;
      const last = cells[cells.length - 1];
      const gap = last ? item.x - last.endX : 0;
      if (!last || gap > size * CELL_GAP_RATIO) {
        if (piece.trim()) cells.push({ text: piece.trim(), x: item.x, endX: item.x + item.width });
        // A blank run wide enough to be its own cell is a GAP, not a cell: it is what
        // separates two columns, and turning it into an empty cell invents a column.
        else if (last) last.endX = item.x + item.width;
        continue;
      }
      last.endX = item.x + item.width;
      if (!piece.trim()) {
        if (!last.text.endsWith(' ')) last.text += ' ';
        continue;
      }
      const needsSpace = gap > size * 0.18 && !last.text.endsWith(' ');
      last.text += needsSpace ? ` ${piece.trim()}` : piece.trim();
    }
    const trimmed = cells.map((cell) => ({ ...cell, text: cell.text.trim() })).filter((cell) => cell.text);
    if (trimmed.length === 0) continue;
    lines.push({
      text: trimmed.map((cell) => cell.text).join(' '),
      cells: trimmed,
      y: row[0].y,
      endX: Math.max(...trimmed.map((cell) => cell.endX)),
      fontSize: fontSize || median(sizes),
    });
  }
  return lines;
}

/** Digits and case removed, so "Página 3 de 12" and "Página 4 de 12" are the same line. */
function boilerplateKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/** How many lines at each end of a page can be running heads. */
const BAND = 3;

/**
 * The band never reaches more than a third of the way into a page from either end. Without
 * this a sparse page — a cover, a signature page — is ENTIRELY inside the band, and a
 * sentence that legitimately appears on every page of a contract gets deleted as furniture.
 */
function bandOf(lines: Line[]): number {
  return Math.max(1, Math.min(BAND, Math.floor(lines.length / 3)));
}

/**
 * Drop the lines that repeat at the same end of most pages.
 *
 * Deliberately conservative: three pages minimum and a majority of them, and only within
 * the top and bottom bands. A recurring clause in the BODY of a contract is content, and
 * removing it because it repeats would be the app editing the client's document.
 */
export function stripBoilerplate(pages: Line[][]): Line[][] {
  if (pages.length < 3) return pages;
  const topCounts = new Map<string, number>();
  const bottomCounts = new Map<string, number>();
  const bump = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) || 0) + 1);

  for (const lines of pages) {
    const band = bandOf(lines);
    const seenTop = new Set<string>();
    const seenBottom = new Set<string>();
    lines.slice(0, band).forEach((line) => seenTop.add(boilerplateKey(line.text)));
    lines.slice(-band).forEach((line) => seenBottom.add(boilerplateKey(line.text)));
    seenTop.forEach((key) => bump(topCounts, key));
    seenBottom.forEach((key) => bump(bottomCounts, key));
  }

  const threshold = Math.max(3, Math.ceil(pages.length * 0.6));
  const repeats = (counts: Map<string, number>, key: string) => (counts.get(key) || 0) >= threshold;

  return pages.map((lines) => {
    const band = bandOf(lines);
    return lines.filter((line, index) => {
      const key = boilerplateKey(line.text);
      if (!key) return false;
      const inTop = index < band;
      const inBottom = index >= lines.length - band;
      if (inTop && repeats(topCounts, key)) return false;
      if (inBottom && repeats(bottomCounts, key)) return false;
      return true;
    });
  });
}

function columnStarts(line: Line): number[] {
  return line.cells.map((cell) => Math.round(cell.x));
}

function sameColumns(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, i) => Math.abs(value - b[i]) <= COLUMN_ALIGN_TOLERANCE);
}

function renderTable(rows: Line[]): string {
  const escape = (text: string) => text.replace(/\|/g, '\\|');
  const header = rows[0].cells.map((cell) => escape(cell.text));
  const body = rows.slice(1).map((row) => row.cells.map((cell) => escape(cell.text)));
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((cells) => `| ${cells.join(' | ')} |`),
  ].join('\n');
}

/**
 * One page's lines as Markdown: `#`/`##` for headings, `-` for bullets, GFM pipe tables for
 * aligned multi-column runs, blank lines between paragraphs.
 */
export function renderPage(lines: Line[]): PageStructure {
  const body = bodyFontSize(lines);
  const out: string[] = [];
  let headings = 0;
  let lists = 0;
  let tables = 0;

  // The right margin the body text actually reaches. A line stopping well short of it is
  // the END of a paragraph; a line reaching it wrapped, and the next line continues it.
  const marginRight = Math.max(0, ...lines.map((line) => line.endX));
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) {
      // A line broken mid-word or mid-URL is rejoined without a space. The hyphen is KEPT:
      // dropping it would silently edit "legal-content" into "legalcontent", and this
      // module is not allowed to change the client's characters.
      const joined = paragraph.reduce((acc, line) => (acc.endsWith('-') ? acc + line : acc ? `${acc} ${line}` : line), '');
      out.push(joined);
    }
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // A table is at least two consecutive lines that agree on where their columns start.
    if (line.cells.length >= 2) {
      const starts = columnStarts(line);
      const run = [line];
      let j = i + 1;
      while (j < lines.length && lines[j].cells.length >= 2 && sameColumns(columnStarts(lines[j]), starts)) {
        run.push(lines[j]);
        j += 1;
      }
      if (run.length >= 2) {
        flush();
        out.push(renderTable(run));
        tables += 1;
        i = j - 1;
        continue;
      }
    }

    if (BULLET.test(line.text)) {
      flush();
      out.push(line.text.replace(BULLET, '- '));
      lists += 1;
      continue;
    }

    if (body > 0 && line.fontSize >= body * HEADING_RATIO && line.text.length <= HEADING_MAX_CHARS) {
      flush();
      out.push(`${line.fontSize >= body * MAJOR_HEADING_RATIO ? '#' : '##'} ${line.text}`);
      headings += 1;
      continue;
    }

    paragraph.push(line.text);
    const next = lines[i + 1];
    const endsShort = line.endX < marginRight - line.fontSize * 1.5;
    const gapBelow = next ? line.y - next.y > line.fontSize * 1.8 : true;
    if (endsShort || gapBelow) flush();
  }
  flush();

  // Every block is separated by a blank line, EXCEPT consecutive bullets, which are one
  // list. The segmenter splits on blank lines, so this is what decides where a citation's
  // excerpt begins and ends.
  const text: string[] = [];
  out.forEach((block, i) => {
    const prev = out[i - 1];
    const runOn = prev !== undefined && prev.startsWith('- ') && block.startsWith('- ');
    if (i > 0 && !runOn) text.push('');
    text.push(block);
  });

  return { text: text.join('\n'), headings, lists, tables };
}

/** The whole document: strip what repeats, then render each page. */
export function renderDocument(pages: TextItem[][]): DocumentStructure {
  const stripped = stripBoilerplate(pages.map(buildLines));
  const rendered = stripped.map(renderPage);
  const tables = rendered.reduce((sum, page) => sum + page.tables, 0);
  return {
    pages: rendered.map((page) => page.text),
    headings: rendered.reduce((sum, page) => sum + page.headings, 0),
    lists: rendered.reduce((sum, page) => sum + page.lists, 0),
    tables,
    tableConfidence: tables > 0 ? 'baixa' : 'n/a',
  };
}
