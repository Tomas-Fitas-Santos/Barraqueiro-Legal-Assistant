import type { SourceKind } from '@/lib/ingest-types';

// What kind of file is this?
//
// Magic number first, extension to break ties, mime last — in that order for a reason:
// browsers send `application/octet-stream` for `.msg` as a matter of routine, and OneDrive's
// `file.mimeType` is unreliable for exactly the formats this has to tell apart.

const OLE2_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || '').trim());
  return match ? match[1].toLowerCase() : '';
}

/**
 * Does this look like an RFC822 message? Deliberately strict: a loose sniff would claim
 * any text file that happens to start with a word and a colon.
 */
function looksLikeRfc822(head: Buffer): boolean {
  const text = head.subarray(0, 4096).toString('latin1');
  const headerBlock = text.split(/\r?\n\r?\n/)[0] || '';
  const known = /^(from|to|cc|bcc|subject|date|message-id|received|mime-version|return-path):/i;
  const hits = headerBlock.split(/\r?\n/).filter((line) => known.test(line)).length;
  return hits >= 2;
}

export function detectKind(head: Buffer, name: string, mime = ''): SourceKind {
  const ext = extensionOf(name);
  const type = String(mime || '').toLowerCase();

  if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image_jpeg';
  if (head.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image_png';
  // Every modern Office format is a zip. So is a .docx template and nothing else we take.
  if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'office';

  if (head.subarray(0, 8).equals(OLE2_SIGNATURE)) {
    // OLE2 is the container for BOTH an Outlook .msg and a legacy .doc/.xls. The root
    // entry's CLSID tells them apart; the extension is the fallback when it cannot be read.
    return isOutlookMessage(head) || ext === 'msg' ? 'email_msg' : 'office';
  }

  if (ext === 'eml' || type === 'message/rfc822') return 'email_eml';
  if (ext === 'msg') return 'email_msg';
  if (looksLikeRfc822(head)) return 'email_eml';
  // Before the text branch: a .json IS text, but it is rendered rather than printed.
  if (ext === 'json' || type === 'application/json') return 'json';
  if (['txt', 'md', 'csv', 'log'].includes(ext) || type.startsWith('text/')) return 'text';
  return 'unknown';
}

/** The MAPI message CLSID, carried by the ROOT DIRECTORY ENTRY of an Outlook .msg. */
const MSG_CLSID = Buffer.from('0b0d020000000000c000000000000046', 'hex');

/**
 * Read the compound file's root entry and check its class id. The entry is not in the
 * header — the header points at the directory sector, and the root entry is the first
 * 128-byte record there, with its CLSID at +0x50.
 */
function isOutlookMessage(head: Buffer): boolean {
  if (head.length < 512) return false;
  const sectorShift = head.readUInt16LE(0x1e);
  if (sectorShift !== 9 && sectorShift !== 12) return false;
  const sectorSize = 1 << sectorShift;
  const firstDirectorySector = head.readInt32LE(0x30);
  if (firstDirectorySector < 0) return false;
  const clsidAt = sectorSize + firstDirectorySector * sectorSize + 0x50;
  // Only the head was read; a directory sector further in means we fall back to the
  // extension, which is what named the file .msg in the first place.
  if (clsidAt + 16 > head.length) return false;
  return head.subarray(clsidAt, clsidAt + 16).equals(MSG_CLSID);
}
