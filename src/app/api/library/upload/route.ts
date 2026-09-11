import { NextResponse } from 'next/server';

import { jsonError } from '@/app/api/_helpers';
import { LIBRARY_FOLDERS } from '@/lib/library-layout';
import { requireSession } from '@/lib/server/auth';
import { genId } from '@/lib/server/crypto';
import { getDb } from '@/lib/server/db';
import { ingestDocument, storeOriginalBytes } from '@/lib/server/ingest/pipeline';
import { uploadToLibrary } from '@/lib/server/graph-files';
import { isLibraryConfigured } from '@/lib/server/msgraph';
import { maxUploadBytes } from '@/lib/server/paths';
import { getDocumentDetail, seedLocalFolders } from '@/lib/server/repo/library';

// Upload a document straight into the library (multipart "file"). It becomes a normal
// library row — same pipeline, same citations — just sourced locally instead of from the
// OneDrive delta feed, so a user can bring a document the library does not have yet.
//
// ANY kind of document is accepted, because that is what a client's OneDrive holds. The
// file is stored and mirrored exactly as it arrived; only the TEXT side needs a PDF, and
// a non-PDF gets one by conversion (see resolvePdfRendition). A document whose text
// cannot be extracted yet still lands in the library — it just says why.
export async function POST(req: Request) {
  try {
    await requireSession();
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: 'Nenhum ficheiro recebido.' }, { status: 400 });
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length === 0) return NextResponse.json({ ok: false, error: 'Ficheiro vazio.' }, { status: 400 });
    if (bytes.length > maxUploadBytes()) {
      return NextResponse.json({ ok: false, error: 'Ficheiro demasiado grande.' }, { status: 413 });
    }
    // No folder means the client's own documents folder, not the library root: the root
    // is structure now, not a place files belong.
    const folderPath =
      String(form.get('folder') || '').replace(/^\/+|\/+$/g, '') || LIBRARY_FOLDERS.official;
    const name = file.name || 'documento';
    const mime = file.type || 'application/octet-stream';
    const documentId = genId('doc');
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'listed', 0, ?, ?, ?)`,
      )
      .run(documentId, `local-${documentId}`, name, folderPath, mime, bytes.length, now, now, now);
    const sha = storeOriginalBytes(bytes);
    // An upload can introduce a folder nobody has seen before; on a local-only install the
    // delta sync is never going to tell us about it.
    seedLocalFolders();

    // 1) Into the client's OneDrive first, adopting the real item id: the next delta sync
    // recognises it as the same document, and a non-PDF needs that item to be converted.
    let uploadedToDrive = false;
    if (isLibraryConfigured()) {
      try {
        const uploaded = await uploadToLibrary(name, bytes, folderPath, mime);
        getDb()
          .prepare('UPDATE documents SET drive_item_id = ?, web_url = ?, updated_at = ? WHERE document_id = ?')
          .run(uploaded.itemId, uploaded.webUrl, Date.now(), documentId);
        uploadedToDrive = true;
      } catch (error) {
        console.warn('[legal] Upload to OneDrive failed; document stays local:', error);
      }
    }

    // 2) Then read it. A document the pipeline cannot read yet (a non-PDF with no Graph
    // to convert it, a corrupt file) still belongs in the library — the row carries the
    // reason and the user can reprocess later.
    let result = null;
    let indexError = '';
    try {
      result = await ingestDocument(documentId, { force: true, stagedSha: sha });
    } catch (error) {
      indexError = error instanceof Error ? error.message : String(error);
    }

    return NextResponse.json({
      ok: true,
      document: getDocumentDetail(documentId),
      result,
      indexError,
      uploadedToDrive,
    });
  } catch (error) {
    return jsonError(error);
  }
}
