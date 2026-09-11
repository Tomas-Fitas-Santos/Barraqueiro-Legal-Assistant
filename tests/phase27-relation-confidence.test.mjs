import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadTsModule } from './helpers.mjs';

// Workstream G — every relation says how sure the app is that it is REAL.
//
// The engine already gathered the evidence; it just never said what the evidence amounted
// to. The user was asked to confirm a proposal knowing its relevância — how much the
// document would change the analysis — and nothing about whether the link existed.

const { relationConfidence, deterministicRelevance } = await loadTsModule('src/lib/server/relations-rules.ts');

const NONE = {
  exactReferenceHit: false,
  titleMention: false,
  aiEvidenceVerified: false,
  aiEvidenceClaimed: false,
  semanticOnly: false,
  manual: false,
};

describe('workstream G — confiança on a relation', () => {
  it('rests on text the app matched itself', () => {
    assert.equal(relationConfidence({ ...NONE, exactReferenceHit: true }).level, 'alta');
    assert.equal(relationConfidence({ ...NONE, titleMention: true }).level, 'media');
  });

  it('trusts a model citation only once it has been found on the page', () => {
    const verified = relationConfidence({ ...NONE, aiEvidenceVerified: true, aiEvidenceClaimed: false });
    assert.equal(verified.level, 'alta');

    // A citation that did NOT check out is worse than none: something was asserted and the
    // app went looking and could not find it.
    const unverified = relationConfidence({ ...NONE, aiEvidenceClaimed: true });
    assert.equal(unverified.level, 'baixa');
    assert.match(unverified.basis, /não foi encontrada/);

    const silent = relationConfidence({ ...NONE });
    assert.equal(silent.level, 'baixa');
    assert.notEqual(silent.basis, unverified.basis, 'a failed citation reads the same as no citation');
  });

  it('never lets similarity alone read as confirmed', () => {
    // §9's rule stated as a band. Similarity may put a pair in front of the user; it may
    // never be what tells them the link is real.
    const semantic = relationConfidence({ ...NONE, semanticOnly: true });
    assert.equal(semantic.level, 'nao_confirmada');
    assert.match(semantic.basis, /semelhança/);
  });

  it('treats a person as the strongest evidence there is', () => {
    const manual = relationConfidence({ ...NONE, manual: true, semanticOnly: true });
    assert.equal(manual.level, 'alta');
    assert.match(manual.basis, /por si/);
  });

  it('always says WHY, because a bare band is a guess with a badge on', () => {
    for (const key of ['exactReferenceHit', 'titleMention', 'aiEvidenceVerified', 'aiEvidenceClaimed', 'semanticOnly', 'manual']) {
      const { basis } = relationConfidence({ ...NONE, [key]: true });
      assert.ok(basis.length > 10, `${key} produced no basis`);
    }
    assert.ok(relationConfidence(NONE).basis.length > 10);
  });

  it('is a different axis from relevância and must not collapse into it', () => {
    // The case the whole workstream exists for: the closest document in the library, on the
    // same subject, with no reference to it anywhere in the text. Worth reading — and
    // resting on nothing. One band would have to lie about one of the two.
    const signals = {
      exactReferenceHit: false,
      titleMention: false,
      topicOverlap: 0,
      entityMatch: false,
      sameFolder: false,
      semanticRank: 1,
      strongType: false,
    };
    assert.equal(deterministicRelevance(signals), 'media');
    assert.equal(relationConfidence({ ...NONE, semanticOnly: true }).level, 'nao_confirmada');

    // And the inverse: a passing citation of a document about something else entirely.
    assert.equal(deterministicRelevance({ ...signals, exactReferenceHit: true, semanticRank: null }), 'alta');
    assert.equal(relationConfidence({ ...NONE, exactReferenceHit: true }).level, 'alta');
  });
});
