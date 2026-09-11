import { genId } from '@/lib/server/crypto';
import { getDb } from '@/lib/server/db';
import type { EmailAttachment } from '@/lib/server/ingest/email';
import { storeOriginalBytes } from '@/lib/server/ingest/store';
import { maxUploadBytes } from '@/lib/server/paths';

// An e-mail's attachments, promoted to documents of their own.
//
// The substance of a legal e-mail is usually the file attached to it, so leaving attachments
// inside the envelope would mean the app could read the covering note and not the contract.
// Each one becomes an ordinary library row and goes through the ordinary pipeline.

/** Nested e-mails are followed, but not indefinitely. */
export const MAX_ATTACHMENT_DEPTH = 2;
const MAX_PER_EMAIL = 20;
/** Below this, an inline part is a signature logo or a tracking pixel, not a document. */
const INLINE_KEEP_BYTES = 100 * 1024;
const DOCUMENT_MIME = /^(application\/(pdf|vnd\.|msword|rtf)|message\/|text\/)/i;

export type ExtractionResult = { ids: string[]; skipped: number; note: string };

export function createAttachmentDocuments(
  parent: { documentId: string; name: string; path: string; sha256: string },
  attachments: EmailAttachment[],
  depth: number,
): ExtractionResult {
  if (depth >= MAX_ATTACHMENT_DEPTH) {
    return { ids: [], skipped: attachments.length, note: attachments.length ? skippedNote(attachments.length) : '' };
  }

  const db = getDb();
  const base = parent.name.replace(/\.(eml|msg)$/i, '');
  const ids: string[] = [];
  let skipped = 0;
  let budget = maxUploadBytes();

  for (const attachment of attachments) {
    if (ids.length >= MAX_PER_EMAIL || !worthKeeping(attachment) || attachment.bytes.length > budget) {
      skipped += 1;
      continue;
    }
    budget -= attachment.bytes.length;

    // Deliberately the ordinary originals store: an attachment is a document like any
    // other, and the download route already serves documents from there.
    const sha = storeOriginalBytes(attachment.bytes);
    // Deterministic from CONTENT, so re-reading the same e-mail finds the same row instead
    // of making a second one. The `local-` prefix keeps every existing "don't call Graph
    // with this id" guard working, because that is exactly what it means here.
    const driveItemId = `local-att-${parent.sha256.slice(0, 12)}-${sha.slice(0, 12)}`;
    const existing = db.prepare('SELECT document_id FROM documents WHERE drive_item_id = ?').get(driveItemId) as
      | { document_id: string }
      | undefined;
    if (existing) {
      ids.push(existing.document_id);
      continue;
    }

    const documentId = genId('doc');
    const now = Date.now();
    // Same `path` as the e-mail: the Library promises a true mirror of OneDrive, and a
    // folder in the breadcrumbs that does not exist there would be a lie.
    db.prepare(
      `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, sha256, state, removed,
                              synced_at, created_at, updated_at, parent_document_id, source_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'listed', 0, ?, ?, ?, ?, 'email_attachment')`,
    ).run(
      documentId,
      driveItemId,
      `${base} — ${attachment.filename}`.slice(0, 180),
      parent.path,
      attachment.mimeType,
      attachment.bytes.length,
      sha,
      now,
      now,
      now,
      parent.documentId,
    );
    ids.push(documentId);
  }

  return { ids, skipped, note: skipped ? skippedNote(skipped) : '' };
}

function skippedNote(count: number): string {
  return `${count} anexo(s) não extraído(s): excedem o limite de tamanho ou de profundidade.`;
}

/** Keep real attachments; keep inline parts only when they are plausibly documents. */
function worthKeeping(attachment: EmailAttachment): boolean {
  if (attachment.bytes.length === 0) return false;
  if (!attachment.inline) return true;
  return DOCUMENT_MIME.test(attachment.mimeType) || attachment.bytes.length >= INLINE_KEEP_BYTES;
}


