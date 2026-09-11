import { confidenceLabel, fieldsForKind } from '@/lib/extraction-fields';
import { relatedDocumentRelationLabel, RELATION_STATUS_LABELS } from '@/lib/types';

// The extraction JSON, read as a document.
//
// The export is the machine-readable half of an analysis, and it was treated as machine-only:
// it landed in the library beside the DOCX and the PDF and sat there with no preview at all,
// so the one file that records WHY each statement was accepted or refused was also the one
// file nobody could open. Rendering it is not a nicety — the rejections are the record of
// what the app declined to assert, and they exist nowhere else in readable form.
//
// A leaf on purpose: the rendition builders must not reach for the API error type or the
// database, or a plain `node --test` could no longer load them.

export const ANALYSIS_EXPORT_SCHEMA_PREFIX = 'legal-assistant/analysis-export';

type Item = {
  seq?: number;
  kind?: string;
  payload?: Record<string, unknown>;
  accepted?: boolean;
  rejectionReason?: string;
  decision?: string;
};

type Reference = { n?: number; document?: string; version?: string; page?: number; excerpt?: string };

export function isAnalysisExport(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    String((value as { schema?: unknown }).schema || '').startsWith(ANALYSIS_EXPORT_SCHEMA_PREFIX)
  );
}

function rule(): string {
  // Latin-1 only: a box-drawing rule trips the "not representable" note on every page.
  return '-'.repeat(60);
}

function date(value: unknown): string {
  const at = Number(value);
  return at ? new Date(at).toISOString().slice(0, 16).replace('T', ' ') : '—';
}

function text(value: unknown): string {
  const out = String(value ?? '').trim();
  return out || '—';
}

/** The export, laid out the way the review screen lays the same extraction out. */
export function renderAnalysisExportText(data: Record<string, unknown>): string {
  const analysis = (data.analysis || {}) as Record<string, unknown>;
  const extraction = (data.extraction || {}) as Record<string, unknown>;
  const version = (data.version || {}) as Record<string, unknown>;
  const template = (data.template || {}) as Record<string, unknown>;
  const main = data.mainDocument as { name?: string } | null;
  const related = (data.relatedDocuments || []) as Array<Record<string, unknown>>;
  const items = (data.items || []) as Item[];
  const references = (data.references || []) as Reference[];

  const lines: string[] = [];
  lines.push(`${text(analysis.typeLabel)} — dados extraídos`);
  lines.push(rule());
  lines.push(`Documento principal: ${main ? text(main.name) : '—'}`);
  lines.push(`Versão: ${text(version.label)} (${text(version.filename)})`);
  lines.push(`Template: ${text(template.name)} v${text(template.version)}`);
  lines.push(`Gerado em: ${date(data.generatedAt)}`);
  if (text(analysis.instructions) !== '—') lines.push(`Instruções: ${text(analysis.instructions)}`);

  if (related.length) {
    lines.push('');
    lines.push(`Documentos relacionados (${related.length})`);
    for (const doc of related) {
      const relation = relatedDocumentRelationLabel(String(doc.relationType || ''));
      const status = RELATION_STATUS_LABELS[String(doc.status || '')] || '';
      lines.push(`  - ${text(doc.name)}${relation ? ` — ${relation}` : ''}${status ? `, ${status.toLowerCase()}` : ''}`);
    }
  }

  const accepted = items.filter((item) => item.accepted !== false);
  const rejected = items.filter((item) => item.accepted === false);

  lines.push('');
  // The fields the extraction was made with; the app's own list only for exports written
  // before the template existed.
  const fields = ((extraction.fields || []) as Array<{ key: string; label: string }>).map(
    (f) => [f.key, f.label] as [string, string],
  );

  lines.push(rule());
  lines.push(`Conteúdo aceite (${accepted.length})`);
  lines.push('');
  if (!accepted.length) lines.push('(nenhum)');
  for (const item of accepted) lines.push(...renderItem(item, fields));

  // The refusals are half of what this file is for, so they are a section, not a footnote.
  lines.push('');
  lines.push(rule());
  lines.push(`Conteúdo rejeitado (${rejected.length})`);
  lines.push('');
  if (!rejected.length) lines.push('(nenhum)');
  for (const item of rejected) {
    lines.push(...renderItem(item, fields));
    lines.push(`  Motivo da rejeição: ${text(item.rejectionReason)}`);
    lines.push('');
  }

  lines.push(rule());
  lines.push(`Fontes citadas (${references.length})`);
  lines.push('');
  if (!references.length) lines.push('(nenhuma)');
  for (const ref of references) {
    lines.push(`[${text(ref.n)}] ${text(ref.document)} ${text(ref.version)} — página ${text(ref.page)}`);
    if (text(ref.excerpt) !== '—') lines.push(`    “${text(ref.excerpt)}”`);
  }

  lines.push('');
  lines.push(rule());
  lines.push(
    `Extração ${text(extraction.label)} — ${text(extraction.acceptedCount)} aceite(s), ${text(extraction.rejectedCount)} rejeitado(s), aprovada em ${date(extraction.approvedAt)} por ${text(extraction.approvedBy)}.`,
  );
  return lines.join('\n');
}

function renderItem(item: Item, fields: Array<[string, string]>): string[] {
  const payload = item.payload || {};
  const suggestion = payload.ai_suggestion === true ? ' [sugestão da IA]' : '';
  const lines = [`${item.seq ?? '—'}. ${text(payload.topic)}${suggestion}`];
  lines.push(`  ${confidenceLabel(String(payload.evidence_quality || ''))}`);
  const content = String(payload.content ?? '').trim();
  if (content) lines.push(`  ${content}`);
  for (const [key, label] of fields.length ? fields : fieldsForKind(String(item.kind || ''))) {
    if (key === 'topic' || key === 'content') continue;
    const value = String(payload[key] ?? '').trim();
    if (value) lines.push(`  ${label}: ${value}`);
  }
  if (payload.source_page) {
    // Version and excerpt are optional; printing a dash for each turned an honest citation
    // into "página 9 — — “—”".
    const version = String(payload.source_version ?? '').trim();
    const excerpt = String(payload.source_excerpt ?? '').trim();
    const source = [`  Fonte: página ${payload.source_page}`, version].filter(Boolean).join(' ');
    lines.push(excerpt ? `${source} — “${excerpt}”` : source);
  }
  lines.push('');
  return lines;
}
