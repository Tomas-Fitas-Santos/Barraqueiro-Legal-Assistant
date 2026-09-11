import { getDb } from '@/lib/server/db';
import { APPROVAL_STATUSES, DOC_TYPES } from '@/lib/types';

// §8's metadata, and the rule that keeps a human correction alive.
//
// The classifier runs again whenever a document's content hash changes, and until now it
// wrote all twelve of its columns unconditionally — so a user who fixed a wrong date lost
// the fix the next time the file was re-read, silently. That is the bug this file exists to
// close: `documents.metadata_overrides_json` records WHICH fields a person set by hand, and
// `applyClassifierMetadata()` writes only the ones they did not.
//
// One column rather than seventeen `*_is_override` flags, and one field list rather than
// seventeen near-identical branches: the API, the classifier writer and the UI all read the
// same descriptors, so adding a §8 field is one entry here and nothing else.

export type FieldKind = 'text' | 'enum' | 'list';

export type MetadataField = {
  /** The name in the API and the UI. */
  key: string;
  column: string;
  kind: FieldKind;
  /** The classifier's property name, when the AI proposes this field. */
  fromClassifier?: string;
  /** For `enum`: the values accepted. A value outside them is refused, not coerced. */
  values?: readonly string[];
  label: string;
};

export const METADATA_FIELDS: MetadataField[] = [
  { key: 'title', column: 'title', kind: 'text', fromClassifier: 'title', label: 'Título' },
  { key: 'docType', column: 'doc_type', kind: 'enum', values: DOC_TYPES, fromClassifier: 'document_type', label: 'Tipo documental' },
  { key: 'subject', column: 'subject', kind: 'text', fromClassifier: 'subject', label: 'Assunto' },
  { key: 'topics', column: 'topics_json', kind: 'list', fromClassifier: 'topics', label: 'Tema' },
  { key: 'subtopics', column: 'subtopics_json', kind: 'list', fromClassifier: 'subtopics', label: 'Subtemas' },
  { key: 'entity', column: 'entity', kind: 'text', fromClassifier: 'entity', label: 'Entidade' },
  { key: 'groupArea', column: 'group_area', kind: 'text', fromClassifier: 'group_area', label: 'Área do Grupo' },
  { key: 'issuedDate', column: 'issued_date', kind: 'text', fromClassifier: 'issued_date', label: 'Data do documento' },
  { key: 'effectiveDate', column: 'effective_date', kind: 'text', fromClassifier: 'effective_date', label: 'Início de vigência' },
  { key: 'expiryDate', column: 'expiry_date', kind: 'text', fromClassifier: 'expiry_date', label: 'Fim de vigência' },
  { key: 'versionLabel', column: 'version_label', kind: 'text', fromClassifier: 'version_label', label: 'Número de versão' },
  {
    key: 'approvalStatus',
    column: 'approval_status',
    kind: 'enum',
    values: APPROVAL_STATUSES,
    fromClassifier: 'approval_status',
    label: 'Estado do documento',
  },
  { key: 'language', column: 'language', kind: 'text', fromClassifier: 'language', label: 'Idioma' },
  { key: 'legislation', column: 'legislation_json', kind: 'list', fromClassifier: 'legislation', label: 'Legislação citada' },
  { key: 'obligations', column: 'obligations_json', kind: 'list', fromClassifier: 'obligations', label: 'Obrigações' },
  { key: 'deadlines', column: 'deadlines_json', kind: 'list', fromClassifier: 'deadlines', label: 'Datas e prazos' },
];

const BY_KEY = new Map(METADATA_FIELDS.map((f) => [f.key, f]));

export function metadataField(key: string): MetadataField | null {
  return BY_KEY.get(String(key || '')) || null;
}

function overridesOf(documentId: string): Record<string, true> {
  const row = getDb()
    .prepare('SELECT metadata_overrides_json FROM documents WHERE document_id = ?')
    .get(documentId) as { metadata_overrides_json: string } | undefined;
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.metadata_overrides_json || '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.keys(parsed).filter((k) => BY_KEY.has(k)).map((k) => [k, true as const]));
  } catch {
    return {};
  }
}

/** Which fields this document's metadata carries a human answer for. */
export function correctedFields(documentId: string): string[] {
  return Object.keys(overridesOf(documentId)).sort();
}

/** The stored form of a value: a list becomes JSON, everything else a trimmed string. */
function encode(field: MetadataField, value: unknown): string {
  if (field.kind === 'list') {
    const items = Array.isArray(value) ? value : String(value ?? '').split(',');
    return JSON.stringify(items.map((v) => String(v ?? '').trim()).filter(Boolean));
  }
  return String(value ?? '').trim();
}

export type MetadataWrite = { key: string; value: unknown };

/**
 * A person's correction. The value is written AND remembered as theirs — the remembering is
 * the point, because it is what a later re-ingest has to respect.
 *
 * An empty value is still a correction: "this document has no version number" is an answer,
 * and letting the classifier fill it back in would be the app arguing with the user.
 */
export function applyUserMetadata(documentId: string, writes: MetadataWrite[]): string[] {
  const db = getDb();
  const overrides = overridesOf(documentId);
  const applied: string[] = [];
  for (const write of writes) {
    const field = BY_KEY.get(write.key);
    if (!field) continue;
    const encoded = encode(field, write.value);
    if (field.kind === 'enum' && encoded && !field.values?.includes(encoded)) continue;
    db.prepare(`UPDATE documents SET ${field.column} = ?, updated_at = ? WHERE document_id = ?`).run(
      encoded,
      Date.now(),
      documentId,
    );
    overrides[field.key] = true;
    applied.push(field.key);
  }
  if (applied.length > 0) {
    db.prepare('UPDATE documents SET metadata_overrides_json = ?, updated_at = ? WHERE document_id = ?').run(
      JSON.stringify(overrides),
      Date.now(),
      documentId,
    );
  }
  return applied;
}

/**
 * Drop a correction and take the AI's answer back.
 *
 * The suggestion itself is not kept anywhere — the classifier's output was written into the
 * column and then overwritten. So this clears the flag and leaves the value; the next
 * reprocess is what actually restores the suggestion, and the UI says so.
 */
export function clearUserMetadata(documentId: string, keys: string[]): string[] {
  const overrides = overridesOf(documentId);
  const cleared = keys.filter((k) => overrides[k]);
  for (const key of cleared) delete overrides[key];
  if (cleared.length > 0) {
    getDb()
      .prepare('UPDATE documents SET metadata_overrides_json = ?, updated_at = ? WHERE document_id = ?')
      .run(JSON.stringify(overrides), Date.now(), documentId);
  }
  return cleared;
}

/**
 * The classifier's answer, written only where nobody has given a better one.
 *
 * Fields the user corrected are skipped entirely, which is what makes a correction survive
 * every future re-ingest rather than only the current one.
 */
export function applyClassifierMetadata(documentId: string, result: Record<string, unknown>): string[] {
  const db = getDb();
  const overrides = overridesOf(documentId);
  const written: string[] = [];
  for (const field of METADATA_FIELDS) {
    if (!field.fromClassifier || overrides[field.key]) continue;
    if (!(field.fromClassifier in result)) continue;
    const encoded = encode(field, result[field.fromClassifier]);
    if (field.kind === 'enum' && encoded && !field.values?.includes(encoded)) continue;
    db.prepare(`UPDATE documents SET ${field.column} = ? WHERE document_id = ?`).run(encoded, documentId);
    written.push(field.key);
  }
  db.prepare('UPDATE documents SET references_json = ?, classified_at = ?, updated_at = ? WHERE document_id = ?').run(
    JSON.stringify(Array.isArray(result.references) ? result.references : []),
    Date.now(),
    Date.now(),
    documentId,
  );
  return written;
}
