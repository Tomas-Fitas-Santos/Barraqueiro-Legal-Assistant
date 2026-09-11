// Fixtures for the input-type suite (phase 13). Generated rather than committed as blobs so
// the bytes are inspectable and every one stays well under the harness's 1 MB upload cap.
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

// ---- PNG (colour type 6, RGBA — what a screenshot is) -----------------------------------
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
function png(width, height, colorType) {
  const samples = colorType === 6 ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * samples);
    for (let x = 0; x < width; x += 1) {
      // A block of dark pixels on light, so it looks like ink on paper.
      const ink = y > height / 3 && y < (height * 2) / 3 && x % 11 < 6;
      for (let s = 0; s < samples; s += 1) {
        row[1 + x * samples + s] = s === 3 ? 255 : ink ? 20 : 240;
      }
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
writeFileSync(path.join(FIXTURES, 'captura-ecra.png'), png(240, 160, 6));
writeFileSync(path.join(FIXTURES, 'digitalizacao.png'), png(160, 240, 2));

// ---- JPEG with EXIF Orientation = 6 (a phone photo held sideways) -----------------------
execFileSync('pdftoppm', [
  '-jpeg', '-r', '50', '-f', '1', '-l', '1',
  path.join(FIXTURES, 'nota-interna-transparencia-salarial.pdf'),
  path.join(FIXTURES, 'tmp-foto'),
]);
const plain = readFileSync(path.join(FIXTURES, 'tmp-foto-1.jpg'));
// Splice a minimal APP1/Exif segment carrying only the Orientation tag.
const ifd = Buffer.alloc(2 + 12 + 4);
ifd.writeUInt16LE(1, 0);
ifd.writeUInt16LE(0x0112, 2); // Orientation
ifd.writeUInt16LE(3, 4); // SHORT
ifd.writeUInt32LE(1, 6);
ifd.writeUInt16LE(6, 10); // rotate 90° CW
const tiff = Buffer.concat([Buffer.from('II', 'latin1'), Buffer.from([0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]), ifd]);
const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
const app1 = Buffer.alloc(2);
app1.writeUInt16BE(exif.length + 2);
writeFileSync(
  path.join(FIXTURES, 'foto-contrato.jpg'),
  Buffer.concat([plain.subarray(0, 2), Buffer.from([0xff, 0xe1]), app1, exif, plain.subarray(2)]),
);
execFileSync('rm', ['-f', path.join(FIXTURES, 'tmp-foto-1.jpg')]);

// ---- EML: multipart/mixed with a text part, an HTML part and a real PDF attachment ------
const attachedPdf = readFileSync(path.join(FIXTURES, 'nota-interna-transparencia-salarial.pdf'));
const boundary = '----barraqueiro-fixture';
const eml = [
  'From: Joao Silva <joao.silva@exemplo.pt>',
  'To: juridico@barraqueiro.pt',
  'Cc: direcao@barraqueiro.pt',
  'Subject: =?utf-8?B?UmV2aXPDo28gZG8gQ8OzZGlnbyBkZSBDb25kdXRh?=',
  'Date: Tue, 10 Mar 2026 09:12:00 +0000',
  'Message-ID: <fixture-1@exemplo.pt>',
  'MIME-Version: 1.0',
  `Content-Type: multipart/mixed; boundary="${boundary}"`,
  '',
  `--${boundary}`,
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Boa tarde,',
  '',
  'Segue em anexo a nota interna para vossa aprecia=C3=A7=C3=A3o.',
  'A comunica=C3=A7=C3=A3o deve ser feita no prazo de 15 dias =C3=BAteis.',
  '',
  'Cumprimentos,',
  'Jo=C3=A3o Silva',
  '',
  `--${boundary}`,
  'Content-Type: application/pdf; name="Nota Interna.pdf"',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="Nota Interna.pdf"',
  '',
  attachedPdf.toString('base64').replace(/(.{76})/g, '$1\r\n'),
  '',
  `--${boundary}--`,
  '',
].join('\r\n');
writeFileSync(path.join(FIXTURES, 'email-com-anexo.eml'), Buffer.from(eml, 'utf8'));

// ---- A format the app deliberately does not read ----------------------------------------
writeFileSync(
  path.join(FIXTURES, 'foto.heic'),
  Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(64, 7)]),
);

console.log('fixtures written to tests/fixtures');

// ---- MSG: an OLE2 file carrying the MAPI CLSID but no readable message ----------------
// Enough to prove two things the app must get right: that a .msg is DETECTED as an e-mail
// (by the root CLSID, not the extension), and that one it cannot parse fails with a clear
// sentence instead of producing an empty document that merely LOOKS citable.
//
// A faithful .msg has to come from a real Outlook export — the format varies in ways no
// synthetic fixture covers (ANSI vs Unicode substreams, RTF-compressed bodies, embedded
// messages), and msgreader's own writer mis-sizes the mini-stream for a file this small.
const ole = Buffer.alloc(1536, 0);
Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(ole, 0);
ole.writeUInt16LE(0x003e, 0x18); // minor version
ole.writeUInt16LE(0x0003, 0x1a); // major version
ole.writeUInt16LE(0xfffe, 0x1c); // little-endian
ole.writeUInt16LE(9, 0x1e); // 512-byte sectors
ole.writeUInt16LE(6, 0x20); // 64-byte mini sectors
ole.writeInt32LE(1, 0x2c); // one directory sector
ole.writeInt32LE(0, 0x30); // first directory sector
ole.writeInt32LE(4096, 0x38); // mini stream cutoff
Buffer.from('0b0d020000000000c000000000000046', 'hex').copy(ole, 512 + 0x50); // MAPI CLSID
writeFileSync(path.join(FIXTURES, 'email-outlook.msg'), ole);
console.log('msg fixture written');
