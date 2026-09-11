import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readSync, closeSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { LEGAL_FILES_DIR } from '@/lib/server/paths';

// Where a document's bytes live: one file per CONTENT hash, so the same file arriving twice
// — re-uploaded, re-synced, or pulled out of two different e-mails — is stored once.
//
// A leaf on purpose. Both the ingest pipeline and the attachment extractor need it, and
// having the extractor reach back into the pipeline would be a cycle.

const ORIGINALS_DIR = path.join(LEGAL_FILES_DIR, 'originals');

export function sha256Of(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function originalPath(sha256: string): string {
  return path.join(ORIGINALS_DIR, sha256);
}

/** Store bytes content-addressed; returns the hash. Written atomically. */
export function storeOriginalBytes(bytes: Buffer): string {
  const sha = sha256Of(bytes);
  mkdirSync(ORIGINALS_DIR, { recursive: true });
  const target = originalPath(sha);
  if (!existsSync(target)) {
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, target);
  }
  return sha;
}

/** The first bytes of a stored file — enough to identify what kind of file it is. */
export function readHead(filePath: string, length = 4096): Buffer {
  if (!existsSync(filePath)) return Buffer.alloc(0);
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}
