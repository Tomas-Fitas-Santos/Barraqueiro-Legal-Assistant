import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadTsModule } from './helpers.mjs';

// The validator is the app's first line of defence against malformed AI output, so it gets
// unit tests against the exact shipped source (transpiled on the fly — see loadTsModule).
const { validateAgainstSchema } = await loadTsModule('src/lib/server/ai/validate.ts');
const { CITATION_SCHEMA, summaryExtractionSchema } = await loadTsModule('src/lib/server/ai/schemas.ts');

// The §10 content fields, as the app ships them. The schema is now GENERATED from a field
// list the client can change, so this pins the generator: whatever the list says, the
// citation spine and the strictness around it must survive.
const SUMMARY_EXTRACTION_SCHEMA = summaryExtractionSchema([
  { key: 'topic', label: 'Tema', description: 'Tema' },
  { key: 'scope', label: 'Âmbito', description: 'Âmbito' },
  { key: 'content', label: 'Afirmação', description: 'The statement itself', nonEmpty: true },
  { key: 'entity', label: 'Entidades', description: 'Entidades' },
  { key: 'required_action', label: 'Medidas', description: 'Medidas' },
  { key: 'suggested_owner', label: 'Responsável', description: 'Responsável' },
  { key: 'deadline', label: 'Prazo', description: 'Prazo' },
  { key: 'consequence', label: 'Consequência', description: 'Consequência' },
  { key: 'exceptions', label: 'Exceções', description: 'Exceções' },
]);

describe('schema validator', () => {
  it('accepts a valid citation', () => {
    const result = validateAgainstSchema(
      { document_id: 'doc_1', page: 3, excerpt: 'O trabalhador deve…' },
      CITATION_SCHEMA,
    );
    assert.equal(result.ok, true);
  });

  it('rejects a citation with a fabricated shape', () => {
    const result = validateAgainstSchema(
      { document_id: 'doc_1', page: 'three', excerpt: '' },
      CITATION_SCHEMA,
    );
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('$.page')));
    assert.ok(result.errors.some((e) => e.includes('$.excerpt')));
  });

  it('rejects missing required properties and unexpected extras', () => {
    const result = validateAgainstSchema({ page: 1, excerpt: 'x', invented: true }, CITATION_SCHEMA);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('document_id')));
    assert.ok(result.errors.some((e) => e.includes('invented')));
  });

  const fullStatement = {
    topic: 'Canal de denúncia',
    scope: 'Todas as empresas do Grupo',
    statement_type: 'obligation',
    content: 'Comunicar irregularidades ao responsável de compliance.',
    entity: 'Colaboradores',
    required_action: 'Comunicar',
    suggested_owner: '',
    deadline: '',
    consequence: '',
    exceptions: '',
    source_document_id: 'doc_1',
    source_version: '',
    source_page: 12,
    source_excerpt: 'devem comunicar',
    evidence_quality: 'direct',
    ai_suggestion: false,
  };

  it('accepts a well-formed §10 summary extraction', () => {
    const result = validateAgainstSchema({ statements: [fullStatement] }, SUMMARY_EXTRACTION_SCHEMA);
    assert.equal(result.ok, true);
  });

  it('rejects an out-of-enum statement type and a missing §10 field with exact paths', () => {
    const badType = validateAgainstSchema(
      { statements: [{ ...fullStatement, statement_type: 'opinion' }] },
      SUMMARY_EXTRACTION_SCHEMA,
    );
    assert.equal(badType.ok, false);
    assert.ok(badType.errors.some((e) => e.startsWith('$.statements[0].statement_type')));

    const { deadline: _omitted, ...withoutDeadline } = fullStatement;
    const missing = validateAgainstSchema({ statements: [withoutDeadline] }, SUMMARY_EXTRACTION_SCHEMA);
    assert.equal(missing.ok, false);
    assert.ok(missing.errors.some((e) => e.includes('deadline')));
  });

  it('rejects an empty statements array', () => {
    const result = validateAgainstSchema({ statements: [] }, SUMMARY_EXTRACTION_SCHEMA);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('at least 1')));
  });
});
