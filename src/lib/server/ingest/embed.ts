import { createHash } from 'node:crypto';

import { getDb } from '@/lib/server/db';
import { modelsDir } from '@/lib/server/paths';

// The local encoder (briefing §7.9). This is the ONE part of the semantic index that is not
// the subscription model's work, and it is local by necessity rather than by preference: the
// Codex endpoint returns text or structured output and has no route that returns a vector.
//
// It is mechanical, deterministic, costs nothing per call and runs with AI switched off —
// which is also what lets the test suite exercise the index end to end.
//
// SCORES ARE COMPARABLE ONLY TO EACH OTHER. Measured on the client's own documents, a
// passage squarely on the query's subject scores ~0.90 and a passage about vehicle
// maintenance scores ~0.81 — e5's cosine range is compressed, so 0.81 does NOT mean
// "81% related". Every consumer must rank, and none may test against a fixed threshold.

export const EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';
export const EMBEDDING_DIM = 384;

/** e5 is asymmetric: the prefix is part of the model's contract, not decoration. */
export type EmbeddingKind = 'query' | 'passage';

/** Segments are truncated to the model's window; beyond it the extra text is ignored anyway. */
const MAX_CHARS = 1800;
const BATCH = 16;

type Extractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

let extractorPromise: Promise<Extractor | null> | null = null;

/**
 * Loads the encoder once per process. A failure is REMEMBERED as "unavailable" rather than
 * thrown: an install whose model files never downloaded must still ingest, search and
 * analyse documents — it just loses the sixth signal. Every caller degrades.
 */
async function getExtractor(): Promise<Extractor | null> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      try {
        const { pipeline, env } = await import('@huggingface/transformers');
        env.cacheDir = modelsDir();
        env.allowRemoteModels = process.env.LEGAL_EMBED_OFFLINE !== '1';
        return (await pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: 'q8' })) as unknown as Extractor;
      } catch (error) {
        console.error('[embed] encoder unavailable:', error instanceof Error ? error.message : error);
        return null;
      }
    })();
  }
  return extractorPromise;
}

export async function embeddingsAvailable(): Promise<boolean> {
  return (await getExtractor()) !== null;
}

export function textSha256(text: string): string {
  return createHash('sha256').update(text.slice(0, MAX_CHARS)).digest('hex');
}

// --- storage ---------------------------------------------------------------------------
//
// int8 + one float scale: 385 bytes a vector instead of 1536. The vectors are unit-length,
// so the scale is only ever a rounding correction and cosine survives the round trip to
// ~1e-3 — far finer than the differences any consumer acts on.

export function packVector(vec: Float32Array | number[]): Buffer {
  const values = Array.from(vec);
  const scale = Math.max(...values.map((v) => Math.abs(v))) || 1;
  const buf = Buffer.alloc(4 + values.length);
  buf.writeFloatLE(scale, 0);
  values.forEach((v, i) => buf.writeInt8(Math.max(-127, Math.min(127, Math.round((v / scale) * 127))), 4 + i));
  return buf;
}

export function unpackVector(buf: Buffer): Float32Array {
  const scale = buf.readFloatLE(0);
  const out = new Float32Array(buf.length - 4);
  for (let i = 0; i < out.length; i++) out[i] = (buf.readInt8(4 + i) / 127) * scale;
  return out;
}

/** Both operands are unit vectors, so the dot product IS the cosine. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

/** The mean direction of a set of unit vectors, renormalised. A document's centroid. */
export function centroid(vectors: Float32Array[]): Float32Array | null {
  if (vectors.length === 0) return null;
  const out = new Float32Array(EMBEDDING_DIM);
  for (const vec of vectors) for (let i = 0; i < out.length; i++) out[i] += vec[i];
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return null;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

// --- encoding --------------------------------------------------------------------------

/**
 * Encodes texts, reading and writing `embedding_cache` — the same "never twice for the same
 * bytes" contract as `ocr_cache` and `renditions`. This is what makes §7's *não repetir
 * embeddings se o hash não mudou* structural instead of a guard somebody must remember.
 *
 * Returns nulls, one per input, when the encoder is unavailable.
 */
export async function embedTexts(texts: string[], kind: EmbeddingKind): Promise<Array<Float32Array | null>> {
  const out: Array<Float32Array | null> = new Array(texts.length).fill(null);
  if (texts.length === 0) return out;

  const db = getDb();
  const read = db.prepare('SELECT vec FROM embedding_cache WHERE text_sha256 = ? AND model = ? AND kind = ?');
  const pending: Array<{ index: number; sha: string; text: string }> = [];

  texts.forEach((text, index) => {
    const trimmed = text.slice(0, MAX_CHARS);
    const sha = textSha256(trimmed);
    const cached = read.get(sha, EMBEDDING_MODEL, kind) as { vec: Buffer } | undefined;
    if (cached) out[index] = unpackVector(Buffer.from(cached.vec));
    else pending.push({ index, sha, text: trimmed });
  });

  if (pending.length === 0) return out;
  const extractor = await getExtractor();
  if (!extractor) return out;

  const write = db.prepare(
    `INSERT INTO embedding_cache (text_sha256, model, kind, dim, vec, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(text_sha256, model, kind) DO NOTHING`,
  );
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const result = await extractor(
      batch.map((p) => `${kind}: ${p.text}`),
      { pooling: 'mean', normalize: true },
    );
    const vectors = result.tolist();
    batch.forEach((p, j) => {
      const vec = Float32Array.from(vectors[j]);
      out[p.index] = vec;
      write.run(p.sha, EMBEDDING_MODEL, kind, EMBEDDING_DIM, packVector(vec), Date.now());
    });
    // The encoder is synchronous CPU work on the request thread's event loop. Between
    // batches, let everything else in the process run — a backfill must never make the app
    // unresponsive.
    await new Promise((resolve) => setImmediate(resolve));
  }
  return out;
}

export async function embedQuery(text: string): Promise<Float32Array | null> {
  return (await embedTexts([text], 'query'))[0];
}
