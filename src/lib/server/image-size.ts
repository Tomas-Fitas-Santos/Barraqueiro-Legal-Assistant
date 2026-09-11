/**
 * The pixel dimensions of a JPEG or PNG, read from its header.
 *
 * Only the aspect ratio is ever needed — a .docx declares the size it prints an image at —
 * so this reads the header rather than pulling in an image library to decode pixels the app
 * never looks at.
 */
export function imageSize(bytes: Buffer): { width: number; height: number; extension: 'jpeg' | 'png' } | null {
  if (bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    // PNG: IHDR is always the first chunk, width and height as big-endian 32-bit.
    if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), extension: 'png' };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // JPEG: walk the segment chain to the frame header, which is the only place the size is.
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      // Standalone markers carry no length; SOS means the entropy-coded scan, so give up.
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2;
        continue;
      }
      if (marker === 0xda) return null;
      const length = bytes.readUInt16BE(offset + 2);
      // Every SOFn except the two that are not frame headers (DHT-adjacent 0xc4/0xc8/0xcc).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7), extension: 'jpeg' };
      }
      offset += 2 + length;
    }
  }
  return null;
}
