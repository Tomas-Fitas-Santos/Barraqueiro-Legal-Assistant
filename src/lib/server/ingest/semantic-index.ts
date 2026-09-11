import { getDb } from '@/lib/server/db';
import { centroid, embedTexts, packVector, unpackVector, type EmbeddingKind } from '@/lib/server/ingest/embed';

// Building and reading the semantic index. The index is a PROCESSING ARTEFACT — it has no
// screen of its own, and its consumers are relation discovery (§9), the §5.3 relevance band
// and passage selection for extraction.

export type SemanticProfile = {
  /** The document's concepts in normalised pt-PT legal vocabulary. */
  concepts: string[];
  /** The alternative formulations a lawyer would use for the same thing. */
  synonyms: string[];
  /** One line per section, saying what that section is about. */
  sectionAbstracts: string[];
};

export function readSemanticProfile(documentId: string): SemanticProfile {
  const row = getDb()
    .prepare('SELECT semantic_profile_json FROM documents WHERE document_id = ?')
    .get(documentId) as { semantic_profile_json: string } | undefined;
  try {
    const parsed = JSON.parse(row?.semantic_profile_json || '{}') as Partial<SemanticProfile>;
    return {
      concepts: Array.isArray(parsed.concepts) ? parsed.concepts.map(String) : [],
      synonyms: Array.isArray(parsed.synonyms) ? parsed.synonyms.map(String) : [],
      sectionAbstracts: Array.isArray(parsed.sectionAbstracts) ? parsed.sectionAbstracts.map(String) : [],
    };
  } catch {
    return { concepts: [], synonyms: [], sectionAbstracts: [] };
  }
}

/**
 * The text the DOCUMENT as a whole is encoded from.
 *
 * Not the raw first page. Embedding statutory boilerplate retrieves badly — every
 * contract's clause 1 looks like every other contract's clause 1 — so the model's account
 * of what the document is about leads, and the title and topics anchor it. When there is no
 * profile (AI off, or not yet classified) this falls back to the metadata the app has.
 */
function documentSubjectText(documentId: string): string {
  const row = getDb()
    .prepare('SELECT name, title, subject, topics_json, subtopics_json FROM documents WHERE document_id = ?')
    .get(documentId) as
    | { name: string; title: string; subject: string; topics_json: string; subtopics_json: string }
    | undefined;
  if (!row) return '';
  const list = (raw: string): string[] => {
    try {
      const parsed = JSON.parse(raw || '[]');
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  };
  const profile = readSemanticProfile(documentId);
  return [
    row.title || row.name,
    row.subject,
    ...profile.concepts,
    ...profile.synonyms,
    ...profile.sectionAbstracts,
    ...list(row.topics_json),
    ...list(row.subtopics_json),
  ]
    .filter(Boolean)
    .join('. ');
}

export type IndexRun = { segments: number; encoded: number; centroid: boolean };

/**
 * Encodes a document's segments and stores its centroid.
 *
 * Runs AFTER the ingest transaction commits, never inside it: encoding a hundred segments
 * is seconds of CPU, and holding a write transaction open across it would block every other
 * request in the process. Cached vectors make a re-ingest of unchanged text nearly free.
 */
export async function indexDocument(documentId: string): Promise<IndexRun> {
  const db = getDb();
  const rows = db
    .prepare('SELECT segment_id, text FROM segments WHERE document_id = ? ORDER BY page, seq')
    .all(documentId) as Array<{ segment_id: string; text: string }>;
  if (rows.length === 0) {
    db.prepare('UPDATE documents SET centroid = NULL WHERE document_id = ?').run(documentId);
    return { segments: 0, encoded: 0, centroid: false };
  }

  const vectors = await embedTexts(
    rows.map((r) => r.text),
    'passage',
  );
  const write = db.prepare('UPDATE segments SET embedding = ? WHERE segment_id = ?');
  const present: Float32Array[] = [];
  vectors.forEach((vec, i) => {
    if (!vec) return;
    write.run(packVector(vec), rows[i].segment_id);
    present.push(vec);
  });

  // The document vector is the SUBJECT text encoded, not the mean of its segments: a long
  // document's segments average out into a vector about nothing in particular, while its
  // subject line is exactly what a "which documents are about this?" question is asking.
  // The segment mean is the fallback when there is no subject text to encode.
  const subject = documentSubjectText(documentId);
  const [subjectVec] = subject ? await embedTexts([subject], 'passage') : [null];
  const docVec = subjectVec || centroid(present);
  db.prepare('UPDATE documents SET centroid = ? WHERE document_id = ?').run(
    docVec ? packVector(docVec) : null,
    documentId,
  );
  return { segments: rows.length, encoded: present.length, centroid: Boolean(docVec) };
}

export function documentCentroid(documentId: string): Float32Array | null {
  const row = getDb().prepare('SELECT centroid FROM documents WHERE document_id = ?').get(documentId) as
    | { centroid: Buffer | null }
    | undefined;
  return row?.centroid ? unpackVector(Buffer.from(row.centroid)) : null;
}

export type SegmentVector = { segmentId: string; documentId: string; page: number; text: string; vec: Float32Array };

export function segmentVectors(documentIds?: string[]): SegmentVector[] {
  const db = getDb();
  const rows = (
    documentIds && documentIds.length > 0
      ? db
          .prepare(
            `SELECT segment_id, document_id, page, text, embedding FROM segments
              WHERE embedding IS NOT NULL AND document_id IN (${documentIds.map(() => '?').join(',')})
              ORDER BY document_id, page, seq`,
          )
          .all(...documentIds)
      : db
          .prepare(
            'SELECT segment_id, document_id, page, text, embedding FROM segments WHERE embedding IS NOT NULL ORDER BY document_id, page, seq',
          )
          .all()
  ) as Array<{ segment_id: string; document_id: string; page: number; text: string; embedding: Buffer }>;
  return rows.map((row) => ({
    segmentId: row.segment_id,
    documentId: row.document_id,
    page: row.page,
    text: row.text,
    vec: unpackVector(Buffer.from(row.embedding)),
  }));
}

export type DocumentVector = { documentId: string; vec: Float32Array };

export function documentVectors(): DocumentVector[] {
  const rows = getDb()
    .prepare('SELECT document_id, centroid FROM documents WHERE centroid IS NOT NULL AND removed = 0')
    .all() as Array<{ document_id: string; centroid: Buffer }>;
  return rows.map((row) => ({ documentId: row.document_id, vec: unpackVector(Buffer.from(row.centroid)) }));
}

/** Documents with segments but no vectors — what a backfill has left to do. */
export function pendingIndexDocumentIds(limit = 25): string[] {
  const rows = getDb()
    .prepare(
      `SELECT d.document_id FROM documents d
        WHERE d.removed = 0 AND d.centroid IS NULL
          AND EXISTS (SELECT 1 FROM segments s WHERE s.document_id = d.document_id)
        ORDER BY d.updated_at LIMIT ?`,
    )
    .all(limit) as Array<{ document_id: string }>;
  return rows.map((r) => r.document_id);
}

export async function embedSubject(text: string, kind: EmbeddingKind = 'query'): Promise<Float32Array | null> {
  return (await embedTexts([text], kind))[0];
}
