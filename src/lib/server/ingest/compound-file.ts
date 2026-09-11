import { UnreadableFileError } from '@/lib/ingest-types';

// A structural pre-flight for OLE2 compound files (.msg).
//
// This exists because of a real failure: a malformed .msg does not make the MAPI reader
// throw — it makes it walk a sector chain that never ends, allocating until the Node heap
// dies. A heap abort cannot be caught, so the try/catch around the parse was worthless: one
// corrupt attachment in a client's OneDrive would take the whole app down, repeatedly, every
// time the sync retried it.
//
// So the container is validated here, with every loop bounded by the file's own size, before
// the parser is allowed near it. Rejecting a readable file is a wrong answer; hanging on an
// unreadable one is a worse one.

const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const FREESECT = -1;
const ENDOFCHAIN = -2;
const DIFSECT = -4;

const MALFORMED = 'Não foi possível ler este e-mail (.msg): o ficheiro está danificado ou incompleto.';

/** Throws unless `bytes` is a compound file whose directory chain is sane and terminates. */
export function assertReadableCompoundFile(bytes: Buffer): void {
  if (bytes.length < 512 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new UnreadableFileError(MALFORMED);

  const sectorShift = bytes.readUInt16LE(0x1e);
  if (sectorShift !== 9 && sectorShift !== 12) throw new UnreadableFileError(MALFORMED);
  const sectorSize = 1 << sectorShift;
  if (bytes.readUInt16LE(0x1c) !== 0xfffe) throw new UnreadableFileError(MALFORMED);

  const totalSectors = Math.floor((bytes.length - 512) / sectorSize);
  const numFatSectors = bytes.readInt32LE(0x2c);
  if (numFatSectors <= 0 || numFatSectors > totalSectors) throw new UnreadableFileError(MALFORMED);

  const entriesPerSector = sectorSize / 4;
  const difat = readDifat(bytes, sectorSize, totalSectors, numFatSectors, entriesPerSector);

  const fatAt = (sector: number): number => {
    const which = Math.floor(sector / entriesPerSector);
    if (which >= difat.length) return FREESECT;
    const fatSector = difat[which];
    if (fatSector < 0 || fatSector >= totalSectors) return FREESECT;
    const at = 512 + fatSector * sectorSize + (sector % entriesPerSector) * 4;
    if (at + 4 > bytes.length) return FREESECT;
    return bytes.readInt32LE(at);
  };

  // The directory chain is the one msgreader walks first. Bounded by the sector count and
  // guarded against revisiting a sector, so a cycle ends here rather than in the heap.
  let sector = bytes.readInt32LE(0x30);
  const seen = new Set<number>();
  let steps = 0;
  while (sector !== ENDOFCHAIN) {
    if (sector < 0 || sector >= totalSectors || seen.has(sector)) throw new UnreadableFileError(MALFORMED);
    seen.add(sector);
    if (++steps > totalSectors) throw new UnreadableFileError(MALFORMED);
    sector = fatAt(sector);
  }
  if (steps === 0) throw new UnreadableFileError(MALFORMED);
}

function readDifat(
  bytes: Buffer,
  sectorSize: number,
  totalSectors: number,
  numFatSectors: number,
  entriesPerSector: number,
): number[] {
  const difat: number[] = [];
  for (let i = 0; i < 109 && difat.length < numFatSectors; i += 1) {
    const value = bytes.readInt32LE(0x4c + i * 4);
    if (value === FREESECT || value === ENDOFCHAIN) break;
    difat.push(value);
  }
  // Files with more than 109 FAT sectors continue the DIFAT in its own chain — again
  // bounded, because that chain is just as capable of pointing at itself.
  let sector = bytes.readInt32LE(0x44);
  const seen = new Set<number>();
  while (difat.length < numFatSectors && sector >= 0 && sector < totalSectors && !seen.has(sector)) {
    seen.add(sector);
    const base = 512 + sector * sectorSize;
    for (let i = 0; i < entriesPerSector - 1 && difat.length < numFatSectors; i += 1) {
      const at = base + i * 4;
      if (at + 4 > bytes.length) break;
      const value = bytes.readInt32LE(at);
      if (value === FREESECT || value === ENDOFCHAIN || value === DIFSECT) break;
      difat.push(value);
    }
    const nextAt = base + (entriesPerSector - 1) * 4;
    sector = nextAt + 4 <= bytes.length ? bytes.readInt32LE(nextAt) : ENDOFCHAIN;
  }
  return difat;
}
