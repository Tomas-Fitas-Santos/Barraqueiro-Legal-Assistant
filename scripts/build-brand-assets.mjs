// Cut the app's brand assets from the Grupo Barraqueiro logo the client supplied.
//
// Generated rather than hand-cropped so the crops are reproducible and stated: the source
// is one PNG holding the square mark above the BARRAQUEIRO wordmark, and the app needs
// them separately (the wordmark is unreadable in a 32px nav badge).
//
// No white "negative" variant is produced, deliberately. The GRUPO lettering is knocked
// out of the navy square as OPAQUE WHITE pixels, so recolouring every inked pixel to white
// turns the mark into a solid white blob. On dark backgrounds the logo is placed on a white
// safe-area tile instead — which is how a logo with knockout detail is meant to be used, and
// leaves the client's asset untouched.
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import path from 'node:path';

const SOURCE = process.argv[2];
const OUT = path.join(process.cwd(), 'public');

/** The brand navy, read off the source: rgb(15,42,106). */
export const BRAND_NAVY = [15, 42, 106];

function decodePng(bytes) {
  let at = 8;
  const chunks = new Map();
  const idat = [];
  while (at + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString('latin1');
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IDAT') idat.push(data);
    else if (!chunks.has(type)) chunks.set(type, data);
    if (type === 'IEND') break;
    at += 12 + len;
  }
  const ihdr = chunks.get('IHDR');
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  if (ihdr[8] !== 8 || ihdr[9] !== 6 || ihdr[12] !== 0) throw new Error('expected 8-bit RGBA, non-interlaced');
  const rowBytes = width * 4;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y += 1) {
    const start = y * (rowBytes + 1);
    const filter = raw[start];
    const row = Buffer.from(raw.subarray(start + 1, start + 1 + rowBytes));
    for (let i = 0; i < rowBytes; i += 1) {
      const a = i >= 4 ? row[i - 4] : 0;
      const b = prev[i];
      const c = i >= 4 ? prev[i - 4] : 0;
      if (filter === 1) row[i] = (row[i] + a) & 255;
      else if (filter === 2) row[i] = (row[i] + b) & 255;
      else if (filter === 3) row[i] = (row[i] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    row.copy(pixels, y * rowBytes);
    prev = row;
  }
  return { width, height, pixels };
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

function encodePng({ width, height, pixels }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.concat([Buffer.from([0]), pixels.subarray(y * width * 4, (y + 1) * width * 4)]));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Ink = visible and dark. The source is flat navy on transparency. */
const isInk = (p, i) => p[i + 3] > 128 && p[i] + p[i + 1] + p[i + 2] < 600;

/** Tight bounding box of the ink inside a row range. */
function inkBounds(img, fromY, toY) {
  let x0 = img.width;
  let x1 = -1;
  let y0 = toY;
  let y1 = -1;
  for (let y = fromY; y <= toY; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      if (!isInk(img.pixels, (y * img.width + x) * 4)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { x0, x1, y0, y1 };
}

function crop(img, { x0, x1, y0, y1 }, pad = 0) {
  const width = x1 - x0 + 1 + pad * 2;
  const height = y1 - y0 + 1 + pad * 2;
  const pixels = Buffer.alloc(width * height * 4, 0);
  for (let y = y0; y <= y1; y += 1) {
    const src = (y * img.width + x0) * 4;
    const dst = ((y - y0 + pad) * width + pad) * 4;
    img.pixels.copy(pixels, dst, src, src + (x1 - x0 + 1) * 4);
  }
  return { width, height, pixels };
}

/** Box-downsample with alpha weighting, so edges stay clean at small sizes. */
function resize(img, targetW, targetH) {
  const pixels = Buffer.alloc(targetW * targetH * 4, 0);
  const sx = img.width / targetW;
  const sy = img.height / targetH;
  for (let y = 0; y < targetH; y += 1) {
    for (let x = 0; x < targetW; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let oy = Math.floor(y * sy); oy < Math.min(img.height, Math.ceil((y + 1) * sy)); oy += 1) {
        for (let ox = Math.floor(x * sx); ox < Math.min(img.width, Math.ceil((x + 1) * sx)); ox += 1) {
          const i = (oy * img.width + ox) * 4;
          const alpha = img.pixels[i + 3];
          r += img.pixels[i] * alpha;
          g += img.pixels[i + 1] * alpha;
          b += img.pixels[i + 2] * alpha;
          a += alpha;
          n += 1;
        }
      }
      const at = (y * targetW + x) * 4;
      if (a > 0) {
        pixels[at] = Math.round(r / a);
        pixels[at + 1] = Math.round(g / a);
        pixels[at + 2] = Math.round(b / a);
        pixels[at + 3] = Math.round(a / n);
      }
    }
  }
  return { width: targetW, height: targetH, pixels };
}

/** Composite onto an opaque square — a favicon must read on any tab colour. */
function onSquare(img, size, background) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = background[0];
    pixels[i + 1] = background[1];
    pixels[i + 2] = background[2];
    pixels[i + 3] = 255;
  }
  const inset = Math.round(size * 0.12);
  const box = size - inset * 2;
  const scale = Math.min(box / img.width, box / img.height);
  const fitted = resize(img, Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)));
  const offX = Math.round((size - fitted.width) / 2);
  const offY = Math.round((size - fitted.height) / 2);
  for (let y = 0; y < fitted.height; y += 1) {
    for (let x = 0; x < fitted.width; x += 1) {
      const s = (y * fitted.width + x) * 4;
      const alpha = fitted.pixels[s + 3] / 255;
      if (alpha === 0) continue;
      const d = ((y + offY) * size + (x + offX)) * 4;
      for (let c = 0; c < 3; c += 1) {
        pixels[d + c] = Math.round(fitted.pixels[s + c] * alpha + pixels[d + c] * (1 - alpha));
      }
    }
  }
  return { width: size, height: size, pixels };
}

const source = decodePng(readFileSync(SOURCE));

// The source is the mark above the wordmark, separated by a band of empty rows. Find that
// band rather than hardcoding a row number, so a re-supplied logo still cuts correctly.
const rowHasInk = [];
for (let y = 0; y < source.height; y += 1) {
  let n = 0;
  for (let x = 0; x < source.width; x += 1) if (isInk(source.pixels, (y * source.width + x) * 4)) n += 1;
  rowHasInk.push(n > 0);
}
let gapStart = -1;
let gap = null;
for (let y = 0; y < source.height; y += 1) {
  if (!rowHasInk[y] && gapStart < 0) gapStart = y;
  if (rowHasInk[y] && gapStart >= 0) {
    if (y - gapStart > 8) { gap = [gapStart, y - 1]; break; }
    gapStart = -1;
  }
}
if (!gap) throw new Error('could not find the band between the mark and the wordmark');

const mark = crop(source, inkBounds(source, 0, gap[0] - 1));
const lockup = crop(source, inkBounds(source, 0, source.height - 1));

const written = [];
const write = (name, img) => {
  writeFileSync(path.join(OUT, name), encodePng(img));
  written.push(`${name} ${img.width}x${img.height}`);
};

write('barraqueiro-mark.png', resize(mark, 256, Math.round((256 * mark.height) / mark.width)));
write('barraqueiro-logo.png', resize(lockup, 640, Math.round((640 * lockup.height) / lockup.width)));

// The browser tab: white behind the navy mark, so it reads on light and dark chrome alike.
writeFileSync(path.join(process.cwd(), 'src', 'app', 'icon.png'), encodePng(onSquare(mark, 128, [255, 255, 255])));
written.push('src/app/icon.png 128x128');

console.log(`mark rows 0..${gap[0] - 1}, wordmark from ${gap[1] + 1}`);
console.log(written.map((w) => `  ${w}`).join('\n'));
