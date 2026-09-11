import { getDb, getSetting } from '@/lib/server/db';
import { convertItemToPdf, replaceItemContent, storePdfBytes } from '@/lib/server/graph-files';
import { isLibraryConfigured } from '@/lib/server/msgraph';
import { activeTemplateFor } from '@/lib/server/repo/templates';
import { pdfPageCount } from '@/lib/server/repo/conversions';
import { commitRerenderedVersion, rerenderVersionInPlace } from '@/lib/server/repo/versions';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * An id minted against a drive that is no longer the one we are connected to, or by a dev
 * fake. Real OneDrive ids are '<driveId>!<item>', so the drive is readable off the id
 * itself — which is how an id left behind by the OneDrive account switch is recognised
 * instead of being sent to Graph to be rejected.
 */
function foreignItemId(driveId: string, itemId: string): boolean {
  if (!itemId || itemId.startsWith('fake:') || itemId.startsWith('local-')) return true;
  const sep = itemId.indexOf('!');
  if (sep < 0) return false;
  return Boolean(driveId) && itemId.slice(0, sep) !== driveId;
}

/**
 * Where a generated file actually lives NOW.
 *
 * `conversions` remembers the item id it uploaded to, but that record can outlive the drive
 * it refers to: switching the OneDrive account re-created every file with new ids, leaving
 * the conversion rows pointing at a drive Graph will not accept. The synced library is the
 * current truth, so the file is found there by name and the stored id is only a fallback.
 * Empty means there is nothing to rewrite — a superseded version whose file is gone.
 */
function resolveItemId(filename: string, storedId: string, driveId: string): string {
  if (!filename) return foreignItemId(driveId, storedId) ? '' : storedId;
  const row = getDb()
    .prepare(
      `SELECT drive_item_id FROM documents
        WHERE removed = 0 AND name = ? AND drive_item_id != ''
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(filename) as { drive_item_id: string } | undefined;
  const fromLibrary = String(row?.drive_item_id || '');
  if (fromLibrary && !foreignItemId(driveId, fromLibrary)) return fromLibrary;
  return foreignItemId(driveId, storedId) ? '' : storedId;
}

/**
 * Put the Grupo Barraqueiro letterhead on the documents that were generated before it
 * existed, by rewriting them where they stand.
 *
 * This is a deliberate exception to the rule that a template change never touches a document
 * already generated (§14). It was asked for explicitly: the letterhead should read as though
 * it had been there from the start, so no new versions are created and no regeneration is
 * offered — the same version, the same date, the same OneDrive item ids, new bytes.
 *
 * Three things make that safe to run repeatedly:
 *
 *  - The work is idempotent and self-marking. A version already pinned to the current
 *    built-in template version is finished, so a run that dies half way is simply resumed by
 *    the next one, and a finished library needs no flag to say so.
 *  - Documents built from the CLIENT's own template are left alone. Their format is theirs.
 *  - `conversions` stores pdf_sha256, pdf_size and pdf_pages, and some of those PDFs are
 *    already approved. Rewriting bytes without re-stamping those columns would leave an
 *    approval pointing at a hash that no longer exists, so they are re-stamped together with
 *    the file — while state and approved_at are left exactly as they were. An approved
 *    document stays approved; it just has the letterhead on it now.
 */
let running = false;

/** Fire-and-forget, at most one at a time: the sync must not wait on Graph conversions. */
export function backfillLetterheadInBackground(): void {
  if (running) return;
  running = true;
  void backfillLetterhead()
    .then((r) => {
      if (r.rewritten) console.log(`[legal] Letterhead applied to ${r.rewritten} generated document(s).`);
    })
    .catch((error) => {
      console.warn('[legal] Letterhead backfill failed:', error instanceof Error ? error.message : error);
    })
    .finally(() => {
      running = false;
    });
}

export async function backfillLetterhead(): Promise<{
  rewritten: number;
  skipped: number;
  failed: number;
}> {
  const result = { rewritten: 0, skipped: 0, failed: 0 };
  if (!isLibraryConfigured() && process.env.LEGAL_FAKE_GRAPH !== '1') return result;
  const db = getDb();

  const driveId = String(getSetting('graph.drive_id') || '');
  const rows = db
    .prepare(
      `SELECT c.conversion_id, c.version_id, c.onedrive_docx_id, c.onedrive_pdf_id, c.pdf_filename,
              v.filename AS docx_filename, v.template_id, v.template_version, a.type
         FROM conversions c
         JOIN analysis_versions v ON v.version_id = c.version_id
         JOIN analyses a ON a.analysis_id = v.analysis_id
        WHERE c.onedrive_docx_id != '' AND a.state != 'eliminada'
        ORDER BY c.created_at`,
    )
    .all() as Array<{
    conversion_id: string;
    version_id: string;
    onedrive_docx_id: string;
    onedrive_pdf_id: string;
    pdf_filename: string;
    docx_filename: string;
    template_id: string;
    template_version: number;
    type: 'summary' | 'revision';
  }>;

  for (const row of rows) {
    let current;
    try {
      current = activeTemplateFor(row.type);
    } catch {
      result.failed += 1;
      continue;
    }
    // Already carries the current built-in, or was built from the client's own template.
    if (row.template_id !== current.templateId || row.template_version === current.version) {
      result.skipped += 1;
      continue;
    }

    const docxId = resolveItemId(row.docx_filename, row.onedrive_docx_id, driveId);
    if (!docxId) {
      // The file this conversion produced is no longer in the library — a superseded
      // version, or one left behind on a drive we are no longer connected to.
      result.skipped += 1;
      continue;
    }
    const pdfId = resolveItemId(row.pdf_filename, row.onedrive_pdf_id, driveId);

    try {
      const rendered = rerenderVersionInPlace(row.version_id);
      if (!rendered) {
        result.skipped += 1;
        continue;
      }
      // The client's DOCX first. Only once that has landed is anything recorded, so a run
      // that dies here is retried whole rather than remembered as finished.
      await replaceItemContent(docxId, rendered.bytes, DOCX_MIME);

      if (pdfId) {
        const pdfBytes = await convertItemToPdf(docxId, rendered.bytes);
        const pages = await pdfPageCount(pdfBytes);
        if (pages > 0) {
          await replaceItemContent(pdfId, pdfBytes, 'application/pdf');
          const stored = storePdfBytes(pdfBytes);
          db.prepare(
            `UPDATE conversions SET pdf_sha256 = ?, pdf_size = ?, pdf_pages = ?, updated_at = ?
              WHERE conversion_id = ?`,
          ).run(stored.sha256, pdfBytes.length, pages, Date.now(), row.conversion_id);
        }
      }
      commitRerenderedVersion(row.version_id, rendered.bytes, rendered.templateId, rendered.templateVersion);
      // Heal the record while we are here: it pointed at a drive that no longer answers.
      db.prepare(
        'UPDATE conversions SET onedrive_docx_id = ?, onedrive_pdf_id = ?, updated_at = ? WHERE conversion_id = ?',
      ).run(docxId, pdfId, Date.now(), row.conversion_id);
      result.rewritten += 1;
    } catch (error) {
      result.failed += 1;
      console.warn(
        `[legal] Letterhead backfill failed for ${row.version_id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return result;
}
