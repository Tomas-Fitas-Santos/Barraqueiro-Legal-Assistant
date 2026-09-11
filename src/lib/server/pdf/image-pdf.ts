import { deflateSync, inflateSync } from 'node:zlib';

import { IMAGE_ENCODING_MESSAGE, imageTooLargeMessage, UnreadableFileError } from '@/lib/ingest-types';
import { buildPagedPdf, extraObjectNumber, pdfStream, round } from '@/lib/server/pdf/writer';

// A photo or a screenshot, wrapped in a one-page PDF.
//
// Everything downstream of ingestion is defined on a PDF, and the OCR stage is exactly what
// an image of a document needs — it just never reached it, because a JPG was sent to Graph
// to be "converted to PDF" (which Graph does not do for images) and landed in `failed`.
//
// The JPEG path is a PASSTHROUGH: PDF's DCTDecode filter takes JPEG bytes verbatim, so the
// original scan goes into the page untouched. That is not just cheap, it is better — a
// decode/re-encode would cost generation loss on precisely the small, low-contrast text the
// OCR pass is then asked to read.

/** The OCR rasterizer runs at 150 dpi; sizing the page to match reproduces pixels 1:1. */
const RENDER_DPI = 150;
const MAX_SIDE_PT = 1684;
const MIN_SIDE_PT = 200;
const MAX_PIXELS = 50_000_000;
/** Beyond this the decoded-PNG paths downsample, to keep the buffer and the PDF sane. */
const MAX_DECODED_SIDE = 4000;

export type ImagePdfResult = { pdf: Buffer; note: string };

export function imageToPdf(bytes: Buffer, kind: 'image_jpeg' | 'image_png'): ImagePdfResult {
  return kind === 'image_jpeg' ? jpegToPdf(bytes) : pngToPdf(bytes);
}

// ---------------------------------------------------------------------------- JPEG

type JpegInfo = { width: number; height: number; components: number; adobeInverted: boolean };

function readJpeg(bytes: Buffer): JpegInfo {
  let at = 2;
  let adobeInverted = false;
  while (at < bytes.length - 1) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = bytes.readUInt16BE(at + 2);
    // APP14/Adobe with a non-zero transform means the CMYK samples are stored inverted.
    if (marker === 0xee && bytes.subarray(at + 4, at + 9).toString('latin1') === 'Adobe') {
      adobeInverted = bytes[at + 2 + length - 1] !== 0;
    }
    // Any SOF except the arithmetic/lossless ones carries the frame geometry.
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return {
        height: bytes.readUInt16BE(at + 5),
        width: bytes.readUInt16BE(at + 7),
        components: bytes[at + 9],
        adobeInverted,
      };
    }
    at += 2 + length;
  }
  throw new UnreadableFileError(IMAGE_ENCODING_MESSAGE);
}

/** EXIF Orientation (tag 0x0112) — 1..8, or 1 when there is no EXIF to read. */
function readExifOrientation(bytes: Buffer): number {
  let at = 2;
  while (at < bytes.length - 1) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xda) break; // start of scan: no EXIF beyond here
    const length = bytes.readUInt16BE(at + 2);
    if (marker === 0xe1 && bytes.subarray(at + 4, at + 10).toString('latin1') === 'Exif\0\0') {
      const tiff = at + 10;
      if (tiff + 8 > bytes.length) return 1;
      const little = bytes.subarray(tiff, tiff + 2).toString('latin1') === 'II';
      const u16 = (o: number) => (little ? bytes.readUInt16LE(o) : bytes.readUInt16BE(o));
      const u32 = (o: number) => (little ? bytes.readUInt32LE(o) : bytes.readUInt32BE(o));
      const ifd0 = tiff + u32(tiff + 4);
      if (ifd0 + 2 > bytes.length) return 1;
      const count = u16(ifd0);
      for (let i = 0; i < count; i += 1) {
        const entry = ifd0 + 2 + i * 12;
        if (entry + 12 > bytes.length) break;
        if (u16(entry) === 0x0112) {
          const value = u16(entry + 8);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    at += 2 + length;
  }
  return 1;
}

/**
 * The transform for each EXIF orientation, applied in the CONTENT STREAM rather than to the
 * pixels. Free, exact, and it keeps the JPEG passthrough intact — rotating pixels would mean
 * decoding and re-encoding the very image we are trying not to touch.
 *
 * The matrix maps the unit square onto the page; 5..8 also swap the page's sides.
 */
function orientationMatrix(orientation: number, w: number, h: number): { matrix: number[]; swap: boolean } {
  switch (orientation) {
    case 2:
      return { matrix: [-w, 0, 0, h, w, 0], swap: false };
    case 3:
      return { matrix: [-w, 0, 0, -h, w, h], swap: false };
    case 4:
      return { matrix: [w, 0, 0, -h, 0, h], swap: false };
    case 5:
      return { matrix: [0, h, w, 0, 0, 0], swap: true };
    case 6:
      return { matrix: [0, h, -w, 0, w, 0], swap: true };
    case 7:
      return { matrix: [0, -h, -w, 0, w, h], swap: true };
    case 8:
      return { matrix: [0, -h, w, 0, 0, h], swap: true };
    default:
      return { matrix: [w, 0, 0, h, 0, 0], swap: false };
  }
}

function jpegToPdf(bytes: Buffer): ImagePdfResult {
  const info = readJpeg(bytes);
  guardPixels(info.width, info.height);
  const orientation = readExifOrientation(bytes);
  const colorSpace = info.components === 1 ? '/DeviceGray' : info.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
  const decode = info.components === 4 && info.adobeInverted ? '/Decode[1 0 1 0 1 0 1 0]' : '';

  const image = pdfStream(
    `/Type/XObject/Subtype/Image/Width ${info.width}/Height ${info.height}` +
      `/ColorSpace ${colorSpace}/BitsPerComponent 8/Filter/DCTDecode${decode}`,
    bytes,
  );
  return {
    pdf: pageWithImage(info.width, info.height, orientation, image),
    note: orientation !== 1 ? 'Orientação da fotografia corrigida a partir do EXIF.' : '',
  };
}

// ----------------------------------------------------------------------------- PNG

function pngToPdf(bytes: Buffer): ImagePdfResult {
  const chunks = readPngChunks(bytes);
  const ihdr = chunks.get('IHDR');
  if (!ihdr || ihdr.length < 13) throw new UnreadableFileError(IMAGE_ENCODING_MESSAGE);
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  guardPixels(width, height);
  // Adam7 would need a de-interlacer of its own. Rare enough to be worth a clear refusal.
  if (interlace !== 0) throw new UnreadableFileError(IMAGE_ENCODING_MESSAGE);

  const idat = chunks.get('IDAT');
  if (!idat) throw new UnreadableFileError(IMAGE_ENCODING_MESSAGE);

  // Colour types 0 and 2 need no decoding at all: PNG's per-scanline filters ARE PDF's
  // /Predictor 15, so the compressed data goes straight through.
  if ((colorType === 0 || colorType === 2) && (bitDepth === 8 || bitDepth === 16)) {
    const colors = colorType === 2 ? 3 : 1;
    const image = pdfStream(
      `/Type/XObject/Subtype/Image/Width ${width}/Height ${height}` +
        `/ColorSpace ${colorType === 2 ? '/DeviceRGB' : '/DeviceGray'}/BitsPerComponent ${bitDepth}` +
        `/Filter/FlateDecode/DecodeParms<</Predictor 15/Colors ${colors}/BitsPerComponent ${bitDepth}/Columns ${width}>>`,
      idat,
    );
    return { pdf: pageWithImage(width, height, 1, image), note: '' };
  }

  // Palette, greyscale+alpha and RGBA have to be decoded. Screenshots are RGBA, so this is
  // the common path, not the exotic one.
  const decoded = decodePng(idat, { width, height, bitDepth, colorType, palette: chunks.get('PLTE') });
  const scaled = downsample(decoded, width, height);
  const image = pdfStream(
    `/Type/XObject/Subtype/Image/Width ${scaled.width}/Height ${scaled.height}` +
      `/ColorSpace /DeviceRGB/BitsPerComponent 8/Filter/FlateDecode`,
    deflateSync(scaled.rgb, { level: 6 }),
  );
  return {
    pdf: pageWithImage(scaled.width, scaled.height, 1, image),
    note: scaled.width !== width ? 'Imagem reduzida para caber numa página legível.' : '',
  };
}

function readPngChunks(bytes: Buffer): Map<string, Buffer> {
  const chunks = new Map<string, Buffer>();
  const idat: Buffer[] = [];
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString('latin1');
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IDAT') idat.push(data);
    else if (!chunks.has(type)) chunks.set(type, data);
    if (type === 'IEND') break;
    at += 12 + length;
  }
  if (idat.length) chunks.set('IDAT', Buffer.concat(idat));
  return chunks;
}

type PngHeader = { width: number; height: number; bitDepth: number; colorType: number; palette?: Buffer };

/** Inflate, undo the per-scanline filters, and flatten to 8-bit RGB over white. */
function decodePng(idat: Buffer, header: PngHeader): Buffer {
  const { width, height, bitDepth, colorType, palette } = header;
  if (bitDepth !== 8 && !(colorType === 3 && bitDepth <= 8)) {
    throw new UnreadableFileError(IMAGE_ENCODING_MESSAGE);
  }
  const samples = colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const bpp = Math.max(1, Math.ceil((samples * bitDepth) / 8));
  const rowBytes = Math.ceil((width * samples * bitDepth) / 8);

  const raw = inflateSync(idat);
  const out = Buffer.alloc(width * height * 3);
  let prev = Buffer.alloc(rowBytes);

  for (let y = 0; y < height; y += 1) {
    const start = y * (rowBytes + 1);
    if (start + rowBytes >= raw.length + 1) break;
    const filter = raw[start];
    const row = Buffer.from(raw.subarray(start + 1, start + 1 + rowBytes));
    unfilter(row, prev, filter, bpp);
    writeRgbRow(out, y, width, row, { bitDepth, colorType, palette });
    prev = row;
  }
  return out;
}

function unfilter(row: Buffer, prev: Buffer, filter: number, bpp: number): void {
  for (let i = 0; i < row.length; i += 1) {
    const a = i >= bpp ? row[i - bpp] : 0;
    const b = prev[i] || 0;
    const c = i >= bpp ? prev[i - bpp] || 0 : 0;
    switch (filter) {
      case 1:
        row[i] = (row[i] + a) & 0xff;
        break;
      case 2:
        row[i] = (row[i] + b) & 0xff;
        break;
      case 3:
        row[i] = (row[i] + ((a + b) >> 1)) & 0xff;
        break;
      case 4: {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
        break;
      }
      default:
        break;
    }
  }
}

function writeRgbRow(
  out: Buffer,
  y: number,
  width: number,
  row: Buffer,
  header: { bitDepth: number; colorType: number; palette?: Buffer },
): void {
  const { bitDepth, colorType, palette } = header;
  for (let x = 0; x < width; x += 1) {
    const at = (y * width + x) * 3;
    let r = 0;
    let g = 0;
    let b = 0;
    let alpha = 255;
    if (colorType === 3) {
      const index = readIndex(row, x, bitDepth);
      const p = palette ? index * 3 : 0;
      r = palette && p + 2 < palette.length ? palette[p] : 0;
      g = palette && p + 2 < palette.length ? palette[p + 1] : 0;
      b = palette && p + 2 < palette.length ? palette[p + 2] : 0;
    } else if (colorType === 4) {
      r = g = b = row[x * 2];
      alpha = row[x * 2 + 1];
    } else if (colorType === 6) {
      r = row[x * 4];
      g = row[x * 4 + 1];
      b = row[x * 4 + 2];
      alpha = row[x * 4 + 3];
    } else if (colorType === 2) {
      r = row[x * 3];
      g = row[x * 3 + 1];
      b = row[x * 3 + 2];
    } else {
      r = g = b = row[x];
    }
    // Composite over WHITE rather than emitting an /SMask: OCR wants dark on light, and a
    // transparent page renders as nothing at all.
    out[at] = blendOverWhite(r, alpha);
    out[at + 1] = blendOverWhite(g, alpha);
    out[at + 2] = blendOverWhite(b, alpha);
  }
}

function blendOverWhite(value: number, alpha: number): number {
  return alpha >= 255 ? value : Math.round((value * alpha + 255 * (255 - alpha)) / 255);
}

function readIndex(row: Buffer, x: number, bitDepth: number): number {
  if (bitDepth === 8) return row[x];
  const perByte = 8 / bitDepth;
  const byte = row[Math.floor(x / perByte)] || 0;
  const shift = 8 - bitDepth * ((x % perByte) + 1);
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

/** Integer box-downsample, so a phone photo does not become a 40 MB page. */
function downsample(rgb: Buffer, width: number, height: number): { rgb: Buffer; width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= MAX_DECODED_SIDE) return { rgb, width, height };
  const factor = Math.ceil(longest / MAX_DECODED_SIDE);
  const w = Math.max(1, Math.floor(width / factor));
  const h = Math.max(1, Math.floor(height / factor));
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy += 1) {
        for (let dx = 0; dx < factor; dx += 1) {
          const sx = x * factor + dx;
          const sy = y * factor + dy;
          if (sx >= width || sy >= height) continue;
          const at = (sy * width + sx) * 3;
          r += rgb[at];
          g += rgb[at + 1];
          b += rgb[at + 2];
          n += 1;
        }
      }
      const at = (y * w + x) * 3;
      out[at] = n ? Math.round(r / n) : 255;
      out[at + 1] = n ? Math.round(g / n) : 255;
      out[at + 2] = n ? Math.round(b / n) : 255;
    }
  }
  return { rgb: out, width: w, height: h };
}

// ---------------------------------------------------------------------------- shared

function guardPixels(width: number, height: number): void {
  if (width <= 0 || height <= 0) throw new UnreadableFileError(IMAGE_ENCODING_MESSAGE);
  if (width * height > MAX_PIXELS) throw new UnreadableFileError(imageTooLargeMessage(MAX_PIXELS / 1_000_000));
}

function pageWithImage(width: number, height: number, orientation: number, image: Buffer): Buffer {
  const { matrix, swap } = orientationMatrix(orientation, width, height);
  // Page sized in the image's own pixels at the OCR rasterizer's dpi, so `pdftoppm -r 150`
  // gets the original pixels back. Fitting to A4 instead would silently downsample a photo
  // of a contract and cost exactly the small print OCR needs.
  let pageW = ((swap ? height : width) / RENDER_DPI) * 72;
  let pageH = ((swap ? width : height) / RENDER_DPI) * 72;
  const longest = Math.max(pageW, pageH);
  const shortest = Math.min(pageW, pageH);
  const scale = longest > MAX_SIDE_PT ? MAX_SIDE_PT / longest : shortest < MIN_SIDE_PT ? MIN_SIDE_PT / shortest : 1;
  pageW *= scale;
  pageH *= scale;

  const sx = pageW / (swap ? height : width);
  const sy = pageH / (swap ? width : height);
  const placed = [matrix[0] * sx, matrix[1] * sy, matrix[2] * sx, matrix[3] * sy, matrix[4] * sx, matrix[5] * sy];
  const content = Buffer.from(`q ${placed.map(round).join(' ')} cm /Im0 Do Q`, 'latin1');
  const imageRef = extraObjectNumber(1, 0);
  return buildPagedPdf(
    [{ width: pageW, height: pageH, content, resources: `/XObject<</Im0 ${imageRef} 0 R>>` }],
    [image],
    'imagem',
  );
}
