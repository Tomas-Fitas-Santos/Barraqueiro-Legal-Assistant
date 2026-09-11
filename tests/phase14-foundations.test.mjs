import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadTsModule } from './helpers.mjs';

// Phase 14 foundations — the leaves the Library rework is built on.
//
// No server and no database: these are pure modules, and the point of putting them here is
// that the rules they encode (what the user is shown a document's type as, what OneDrive
// will accept as a name, what "the same word" means in Portuguese) were previously either
// absent or duplicated inline in one caller.

const types = await loadTsModule('src/lib/types.ts');
const layout = await loadTsModule('src/lib/library-layout.ts');
const text = await loadTsModule('src/lib/text-normalize.ts');
const schemas = await loadTsModule('src/lib/server/ai/schemas.ts');

describe('documental type — shown in the user’s language, stored as the identifier', () => {
  it('the label map covers the classifier’s vocabulary exactly', () => {
    // The drift guard. The schema derives its enum from DOC_TYPES, so a type added in one
    // place cannot reach the user as a raw English identifier.
    const fromSchema = schemas.CLASSIFICATION_SCHEMA.properties.document_type.enum;
    assert.deepEqual([...fromSchema].sort(), [...types.DOC_TYPES].sort());
    for (const value of fromSchema) {
      assert.ok(types.DOC_TYPE_LABELS[value], `"${value}" has no pt-PT label`);
    }
  });

  it('labels are Portuguese, and an unknown value is shown rather than swallowed', () => {
    assert.equal(types.docTypeLabel('internal_note'), 'Nota interna');
    assert.equal(types.docTypeLabel('code_of_conduct'), 'Código de conduta');
    assert.equal(types.docTypeLabel(''), '—');
    // A hand-corrected value outside the vocabulary is information, not an error.
    assert.equal(types.docTypeLabel('acordo_de_empresa'), 'acordo_de_empresa');
  });

  it('every OCR quality the pipeline writes has a label', () => {
    for (const value of ['n/a', 'pendente', 'boa', 'parcial']) {
      assert.ok(types.OCR_QUALITY_LABELS[value], `"${value}" has no label`);
    }
    assert.equal(types.ocrQualityLabel('boa'), 'Boa');
    assert.equal(types.ocrQualityLabel(''), '—');
  });
});

describe('item names — OneDrive’s rules, checked before the round trip', () => {
  it('accepts an ordinary name and trims it', () => {
    assert.deepEqual(layout.validateItemName('Contratos 2026'), { ok: true, name: 'Contratos 2026' });
    // Trimmed rather than refused: OneDrive does the same and the caller uses the result.
    assert.deepEqual(layout.validateItemName('  Contratos  '), { ok: true, name: 'Contratos' });
    assert.deepEqual(layout.validateItemName('Nota — v2 (final).pdf').ok, true);
  });

  it('refuses what the drive would refuse, each with its own reason', () => {
    const reasons = new Set();
    for (const name of ['', '   ', 'a/b', 'a:b', 'a?b', 'a"b', 'a|b', 'nota.', '.', '..', 'CON', 'com1', 'LPT9', 'desktop.ini', '~$doc.docx', 'x'.repeat(256)]) {
      const result = layout.validateItemName(name);
      assert.equal(result.ok, false, `"${name}" should be refused`);
      assert.ok(result.error.length > 0);
      reasons.add(result.error);
    }
    // Distinct reasons, not one generic refusal — the user has to know what to change.
    assert.ok(reasons.size >= 5, `expected several distinct reasons, got ${reasons.size}`);
    // And they are in the language of the app.
    for (const reason of reasons) assert.doesNotMatch(reason, /^[A-Z][a-z]+ (name|cannot|must)/);
  });

  it('knows which folders the app owns', () => {
    assert.equal(layout.isStructuralFolder('2. Templates'), true);
    assert.equal(layout.isStructuralFolder('3. Resultados/Resumo documental'), true);
    assert.equal(layout.isStructuralFolder('Contratos'), false);
    // Renaming one of these leaves the install with two, because the app recreates it.
    assert.ok(layout.STRUCTURAL_FOLDERS.length >= 3);
  });
});

describe('Portuguese folding — one definition, not one per caller', () => {
  it('ignores what a reader ignores', () => {
    assert.equal(text.foldPt('Concessão'), text.foldPt('concessao'));
    assert.equal(text.foldPt('CÓDIGO de Conduta'), 'codigo de conduta');
    assert.equal(text.foldPt('  Transparência   Salarial '), 'transparencia salarial');
    for (const [a, b] of [['ç', 'c'], ['ã', 'a'], ['õ', 'o'], ['é', 'e'], ['ú', 'u'], ['à', 'a']]) {
      assert.equal(text.foldPt(a), b);
    }
  });

  it('matches both directions — the bug the Library filter had', () => {
    // Typing without accents must find the accented name, and vice versa.
    assert.equal(text.foldedIncludes('Contrato de Concessão.pdf', 'concessao'), true);
    assert.equal(text.foldedIncludes('Contrato de Concessao.pdf', 'concessão'), true);
    assert.equal(text.foldedIncludes('Contrato', ''), false);
  });

  it('splits into words on anything that is not a letter or a digit', () => {
    assert.deepEqual(text.foldTokens('Nota_Interna — v2 (final)'), ['nota', 'interna', 'v2', 'final']);
  });
});
