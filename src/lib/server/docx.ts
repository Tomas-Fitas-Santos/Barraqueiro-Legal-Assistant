import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';

import type { AnalysisItemRow } from '@/lib/server/repo/analyses';
import { getDocumentDetail } from '@/lib/server/repo/library';

// Deterministic document assembly (briefing §10/§11): the numbered reference list and the
// "Anexo de fontes" are built by the APP from the validated items' own citations — the
// narrative may point at them with [n] markers, and unknown markers are stripped, never
// invented. Rendering is docxtemplater over the registry template.

export type NarrativeSection = { heading: string; body: string };

export type ReferenceEntry = {
  n: number;
  documentId: string;
  document: string;
  version: string;
  page: number;
  excerpt: string;
};

/** Deduplicated, numbered reference list from every accepted, user-not-rejected item. */
export function buildReferenceList(items: AnalysisItemRow[]): ReferenceEntry[] {
  const seen = new Map<string, ReferenceEntry>();
  for (const item of items) {
    const p = item.payload;
    if (!p.source_document_id || !p.source_excerpt || Number(p.source_page) <= 0) continue;
    const key = `${p.source_document_id}:${p.source_page}:${String(p.source_excerpt).slice(0, 80)}`;
    if (seen.has(key)) continue;
    const doc = getDocumentDetail(String(p.source_document_id));
    seen.set(key, {
      n: seen.size + 1,
      documentId: String(p.source_document_id),
      document: doc?.title || doc?.name || String(p.source_document_id),
      version: String(p.source_version || doc?.versionLabel || ''),
      page: Number(p.source_page),
      excerpt: String(p.source_excerpt),
    });
  }
  return [...seen.values()];
}

/** Strip [n] markers that don't exist in the reference list — markers are never invented. */
export function sanitizeMarkers(body: string, references: ReferenceEntry[]): { text: string; stripped: number } {
  const valid = new Set(references.map((ref) => ref.n));
  let stripped = 0;
  const text = body.replace(/\[(\d{1,3})\]/g, (match, num) => {
    if (valid.has(Number(num))) return match;
    stripped += 1;
    return '';
  });
  return { text, stripped };
}

/**
 * Deterministic fallback narrative when no AI is configured: the validated items grouped
 * by type, each sentence pointing at its reference. Keeps the product functional (and the
 * DOCX chain fully testable) without a model; the note marks the origin honestly.
 */
export function assembleFallbackNarrative(items: AnalysisItemRow[], references: ReferenceEntry[]): NarrativeSection[] {
  const byKey = new Map(references.map((ref) => [`${ref.documentId}:${ref.page}:${ref.excerpt.slice(0, 80)}`, ref.n]));
  const groups: Record<string, string[]> = {};
  const labels: Record<string, string> = {
    obligation: 'Obrigações',
    deadline: 'Prazos',
    responsibility: 'Responsabilidades',
    sanction: 'Sanções',
    reference: 'Referências',
    definition: 'Definições',
    recommendation: 'Recomendações',
    other: 'Outros pontos',
    matrix: 'Pontos da matriz comparativa',
  };
  for (const item of items) {
    const p = item.payload;
    const kind = item.kind === 'matrix_line' ? 'matrix' : String(p.statement_type || 'other');
    const key = `${p.source_document_id}:${p.source_page}:${String(p.source_excerpt).slice(0, 80)}`;
    const n = byKey.get(key);
    const text = item.kind === 'matrix_line'
      ? `${String(p.topic)}: ${String(p.proposed_change || p.difference)}`
      : String(p.content);
    (groups[kind] ||= []).push(`${text}${n ? ` [${n}]` : ''}`);
  }
  return Object.entries(groups).map(([kind, sentences]) => ({
    heading: labels[kind] || kind,
    body: sentences.join(' '),
  }));
}

export type RenderInput = {
  templateBytes: Buffer;
  docTitle: string;
  subtitle: string;
  mainDocument: string;
  date: string;
  sections: NarrativeSection[];
  references: ReferenceEntry[];
  matrixLines?: Array<{
    topic: string;
    current: string;
    related: string;
    difference: string;
    proposed: string;
    decision: string;
  }>;
};

export function renderDocx(input: RenderInput): Buffer {
  const zip = new PizZip(input.templateBytes);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  doc.render({
    doc_title: input.docTitle,
    subtitle: input.subtitle,
    main_document: input.mainDocument,
    date: input.date,
    sections: input.sections,
    references: input.references.map((ref) => ({
      n: ref.n,
      document: ref.document,
      version: ref.version || '—',
      page: ref.page,
      excerpt: ref.excerpt,
    })),
    lines: input.matrixLines || [],
  });
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}
