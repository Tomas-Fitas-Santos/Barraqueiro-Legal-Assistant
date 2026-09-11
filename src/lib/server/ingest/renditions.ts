import { existsSync, readFileSync } from 'node:fs';

import { ApiError } from '@/app/api/_helpers';
import {
  OFFICE_NEEDS_GRAPH_MESSAGE,
  OFFICE_NOT_ON_DRIVE_MESSAGE,
  UnreadableFileError,
  unsupportedMessage,
  type SourceKind,
} from '@/lib/ingest-types';
import { getDb } from '@/lib/server/db';
import { convertItemToPdf } from '@/lib/server/graph-files';
import { createAttachmentDocuments, MAX_ATTACHMENT_DEPTH } from '@/lib/server/ingest/attachments';
import { detectKind } from '@/lib/server/ingest/detect';
import { parseEmail, renderEmailText } from '@/lib/server/ingest/email';
import { isAnalysisExport, renderAnalysisExportText } from '@/lib/server/ingest/render-export';
import { originalPath, readHead, storeOriginalBytes } from '@/lib/server/ingest/store';
import { canReachDrive, downloadItem } from '@/lib/server/msgraph';
import { imageToPdf } from '@/lib/server/pdf/image-pdf';
import { textToPdf } from '@/lib/server/pdf/text-pdf';

// How each kind of file becomes something the rest of the app can read.
//
// One lever: EVERY accepted format produces a PDF in the originals store. Pages, excerpts,
// citations, the preview iframe and the OCR stage are all defined on a PDF, so giving each
// format a rendition means none of them needs to know that images or e-mails exist.
//
// A second lever, less obvious: when the APP generated the PDF it already knows the text.
// Round-tripping our own words through pdf.js can only lose fidelity, and a short e-mail
// would fall under the OCR threshold and get sent to a vision model to "transcribe" text we
// wrote ourselves. So a strategy may return authoritative page text, and the pipeline uses
// it instead of extracting.

export type Rendition = {
  /** Always a PDF in the originals store. */
  pdfPath: string;
  /** '' when the original IS the PDF. */
  renditionSha: string;
  /** Non-null when the app generated this PDF and therefore knows what is on each page. */
  pageTexts: string[] | null;
  /** True ⇒ never OCR, never mark a page pending. */
  authoritative: boolean;
  /** Documents created from inside this one (an e-mail's attachments). */
  extractedDocumentIds: string[];
  kind: SourceKind;
  /** Anything worth telling the user, appended to the document's state detail. */
  note: string;
};

export async function resolveRendition(args: {
  documentId: string;
  driveItemId: string;
  name: string;
  path: string;
  mime: string;
  originalFile: string;
  sourceSha: string;
  depth: number;
}): Promise<Rendition> {
  const db = getDb();
  const head = readHead(args.originalFile);
  const kind = detectKind(head, args.name, args.mime);

  if (kind === 'pdf') {
    return blank(kind, { pdfPath: args.originalFile });
  }

  // Cached by CONTENT hash, mirroring ocr_cache. This is what makes a stale rendition
  // impossible by construction: edited content has a new hash, misses, and converts afresh.
  // (The old cache hung off the document row, so an edited DOCX was re-read from the PDF of
  // its previous contents.)
  const cached = db.prepare('SELECT pdf_sha256, pages_json, note FROM renditions WHERE source_sha256 = ?').get(
    args.sourceSha,
  ) as { pdf_sha256: string; pages_json: string; note: string } | undefined;
  if (cached) {
    const pages = cached.pages_json ? (JSON.parse(cached.pages_json) as string[]) : null;
    return {
      pdfPath: originalPath(cached.pdf_sha256),
      renditionSha: cached.pdf_sha256,
      pageTexts: pages,
      authoritative: Boolean(pages),
      extractedDocumentIds: [],
      kind,
      note: cached.note || '',
    };
  }

  const built = await build(kind, args);
  const renditionSha = storeOriginalBytes(built.pdf);
  db.prepare(
    `INSERT INTO renditions (source_sha256, pdf_sha256, kind, pages_json, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_sha256) DO UPDATE SET pdf_sha256 = excluded.pdf_sha256, kind = excluded.kind,
       pages_json = excluded.pages_json, note = excluded.note`,
  ).run(
    args.sourceSha,
    renditionSha,
    kind,
    built.pages ? JSON.stringify(built.pages) : '',
    built.note,
    Date.now(),
  );
  db.prepare('UPDATE documents SET text_sha256 = ?, source_kind = ?, updated_at = ? WHERE document_id = ?').run(
    renditionSha,
    kind,
    Date.now(),
    args.documentId,
  );

  return {
    pdfPath: originalPath(renditionSha),
    renditionSha,
    pageTexts: built.pages,
    authoritative: Boolean(built.pages),
    extractedDocumentIds: built.extractedDocumentIds,
    kind,
    note: built.note,
  };
}

type Built = { pdf: Buffer; pages: string[] | null; note: string; extractedDocumentIds: string[] };

async function build(
  kind: SourceKind,
  args: { documentId: string; driveItemId: string; name: string; path: string; originalFile: string; sourceSha: string; depth: number },
): Promise<Built> {
  const bytes = readFileSync(args.originalFile);
  try {
    switch (kind) {
      case 'office':
        return { pdf: await convertOffice(args.driveItemId, bytes), pages: null, note: '', extractedDocumentIds: [] };
      case 'image_jpeg':
      case 'image_png': {
        const image = imageToPdf(bytes, kind);
        // No text: the page goes to the OCR stage, which is exactly what an image of a
        // document needs and never used to reach.
        return { pdf: image.pdf, pages: null, note: image.note, extractedDocumentIds: [] };
      }
      case 'email_eml':
      case 'email_msg': {
        const email = await parseEmail(bytes, kind);
        const rendered = textToPdf(renderEmailText(email));
        const extracted = createAttachmentDocuments(
          { documentId: args.documentId, name: args.name, path: args.path, sha256: args.sourceSha },
          email.attachments,
          args.depth,
        );
        const notes = [rendered.note, extracted.note].filter(Boolean);
        if (extracted.ids.length) notes.unshift(`${extracted.ids.length} anexo(s) extraído(s) para a biblioteca.`);
        return {
          pdf: rendered.pdf,
          pages: rendered.pages,
          note: notes.join(' '),
          extractedDocumentIds: extracted.ids,
        };
      }
      case 'text': {
        const rendered = textToPdf(bytes.toString('utf8'));
        return { pdf: rendered.pdf, pages: rendered.pages, note: rendered.note, extractedDocumentIds: [] };
      }
      case 'json': {
        // Two views of one file, and deliberately not the same content. The PDF is the
        // extraction laid out the way the review screen lays it out; the page text stays the
        // raw JSON, because this file's whole purpose is to be the machine-readable record
        // and reading it means reading what is actually in it.
        const raw = bytes.toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new UnreadableFileError(`Não é possível ler “${args.name}”: o ficheiro não é JSON válido.`);
        }
        const readable = isAnalysisExport(parsed)
          ? renderAnalysisExportText(parsed as Record<string, unknown>)
          : JSON.stringify(parsed, null, 2);
        const rendered = textToPdf(readable);
        const asText = textToPdf(JSON.stringify(parsed, null, 2));
        return { pdf: rendered.pdf, pages: asText.pages, note: rendered.note, extractedDocumentIds: [] };
      }
      default:
        throw new UnreadableFileError(unsupportedMessage(args.name));
    }
  } catch (error) {
    // A refusal we chose becomes a 400 with its own sentence; anything else stays as it is.
    if (error instanceof UnreadableFileError) throw new ApiError(error.message, 400);
    throw error;
  }
}

/** The one branch that talks to Graph — and the only one that ever needed to. */
async function convertOffice(driveItemId: string, bytes: Buffer): Promise<Buffer> {
  if (!canReachDrive()) throw new UnreadableFileError(OFFICE_NEEDS_GRAPH_MESSAGE);
  // A locally-uploaded file whose OneDrive push failed keeps its synthetic id. Calling Graph
  // with it produced a confusing 502 about conversion rather than the real problem.
  if (!driveItemId || driveItemId.startsWith('local-')) throw new UnreadableFileError(OFFICE_NOT_ON_DRIVE_MESSAGE);
  return convertItemToPdf(driveItemId, bytes);
}

function blank(kind: SourceKind, over: Partial<Rendition>): Rendition {
  return {
    pdfPath: '',
    renditionSha: '',
    pageTexts: null,
    authoritative: false,
    extractedDocumentIds: [],
    kind,
    note: '',
    ...over,
  };
}

/**
 * The PDF a file that is NEVER INGESTED is previewed through.
 *
 * Templates and generated documents are deliberately kept out of the reading pipeline (they
 * have no subject to classify and nothing to relate to), and the rendition is built there —
 * so "Pré-visualizar" on a template handed the browser a `.docx`, which every browser saves
 * to disk instead of showing. That is what the client reported as "pressing view downloads
 * the document".
 *
 * This builds the rendition ALONE: the same converter, the same content-addressed cache, and
 * none of the OCR, classification or semantic indexing around it. Attachments are never
 * extracted — a preview must not add rows to the library — which is why the depth budget is
 * spent before the call rather than during it.
 */
export async function previewRendition(documentId: string): Promise<string> {
  const db = getDb();
  const row = db
    .prepare('SELECT document_id, drive_item_id, name, path, mime, sha256 FROM documents WHERE document_id = ?')
    .get(documentId) as
    | { document_id: string; drive_item_id: string; name: string; path: string; mime: string; sha256: string }
    | undefined;
  if (!row) return '';

  // A file that is never ingested has never had its bytes fetched either — the pipeline is
  // what normally stores the original. Fetch it here, once, so the first preview works
  // rather than reporting a missing rendition for a file that is sitting on the drive.
  let sha = String(row.sha256 || '');
  if (!sha || !existsSync(originalPath(sha))) {
    if (!canReachDrive()) return '';
    const res = await downloadItem(row.drive_item_id);
    sha = storeOriginalBytes(Buffer.from(await res.arrayBuffer()));
    db.prepare('UPDATE documents SET sha256 = ?, updated_at = ? WHERE document_id = ?').run(sha, Date.now(), documentId);
  }
  const originalFile = originalPath(sha);
  const rendition = await resolveRendition({
    documentId: row.document_id,
    driveItemId: row.drive_item_id,
    name: row.name,
    path: row.path,
    mime: row.mime,
    originalFile,
    sourceSha: sha,
    depth: MAX_ATTACHMENT_DEPTH,
  });
  return rendition.renditionSha ? originalPath(rendition.renditionSha) : rendition.pdfPath;
}

/**
 * The text of a file that is never ingested, for its preview alone.
 *
 * It comes from the rendition cache and NOT from `document_pages`, which is the citation
 * ground truth: a generated document must never become a page a statement can be cited
 * against, or the app would be able to cite its own output back at itself. Being readable
 * and being citable are different permissions, and this is the line between them.
 */
export function previewPages(documentId: string): Array<{ page: number; text: string; ocr: boolean; pendingOcr: boolean }> {
  const row = getDb()
    .prepare(
      `SELECT r.pages_json AS pages_json
         FROM documents d
         JOIN renditions r ON r.source_sha256 = d.sha256
        WHERE d.document_id = ?`,
    )
    .get(documentId) as { pages_json: string } | undefined;
  if (!row?.pages_json) return [];
  try {
    const pages = JSON.parse(row.pages_json) as string[];
    return pages.map((text, index) => ({ page: index + 1, text, ocr: false, pendingOcr: false }));
  } catch {
    return [];
  }
}
