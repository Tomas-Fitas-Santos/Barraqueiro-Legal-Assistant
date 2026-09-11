import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadTsModule } from './helpers.mjs';

// Every preview offered the same two buttons — PDF and Texto — because a PDF is what the
// app produces for anything it can read. For three kinds that was the wrong answer, and in
// each case it put a conversion between the reader and the thing they opened the preview to
// check.

const { previewKindOf, previewModesFor, previewModeLabel } = await loadTsModule('src/lib/preview-modes.ts');

describe('what "see this document" means depends on the document', () => {
  it('reads the kind from the name or the mime, whichever it has', () => {
    assert.equal(previewKindOf('dados-resumo.json', ''), 'extraction');
    assert.equal(previewKindOf('sem-extensao', 'application/json'), 'extraction');
    assert.equal(previewKindOf('email-resumo.eml', ''), 'email');
    assert.equal(previewKindOf('mensagem.msg', ''), 'email');
    assert.equal(previewKindOf('digitalizacao.png', ''), 'image');
    assert.equal(previewKindOf('foto', 'image/jpeg'), 'image');
    assert.equal(previewKindOf('nota.pdf', ''), 'pdf');
    assert.equal(previewKindOf('nota-resumo.docx', ''), 'document');
  });

  it('never wraps an image, an e-mail or an extraction in a PDF', () => {
    // A photograph IS the document; a PDF around it is a viewer between the user and the
    // picture. An .eml previewed as a PDF of a text rendering of it is two conversions away
    // from the headers someone opened it to check.
    for (const kind of ['image', 'email', 'extraction']) {
      assert.ok(!previewModesFor(kind).includes('pdf'), `${kind} still offers a PDF`);
    }
    assert.deepEqual(previewModesFor('pdf'), ['pdf', 'texto']);
    assert.deepEqual(previewModesFor('document'), ['pdf', 'texto']);
  });

  it('always offers exactly two: one to read, one showing the file as it is', () => {
    for (const kind of ['pdf', 'document', 'image', 'email', 'extraction']) {
      const modes = previewModesFor(kind);
      assert.equal(modes.length, 2, `${kind} does not offer two views`);
      assert.equal(new Set(modes).size, 2, `${kind} offers the same view twice`);
    }
    assert.deepEqual(previewModesFor('image'), ['imagem', 'texto']);
    assert.deepEqual(previewModesFor('email'), ['mensagem', 'fonte']);
    assert.deepEqual(previewModesFor('extraction'), ['dados', 'fonte']);
  });

  it('labels the raw view for what it actually is in that kind', () => {
    // "Origem" for an e-mail is its MIME source; for an extraction the raw file is JSON,
    // and calling it anything else would hide that the JSON is the record.
    assert.equal(previewModeLabel('fonte', 'extraction'), 'JSON');
    assert.equal(previewModeLabel('fonte', 'email'), 'Origem');
    assert.equal(previewModeLabel('texto', 'pdf', true), 'Texto + citação');
    assert.equal(previewModeLabel('texto', 'pdf', false), 'Texto');
    for (const kind of ['pdf', 'document', 'image', 'email', 'extraction']) {
      for (const mode of previewModesFor(kind)) {
        assert.ok(previewModeLabel(mode, kind).length > 0, `${kind}/${mode} has no label`);
      }
    }
  });
});
