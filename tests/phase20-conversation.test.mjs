import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadTsModule } from './helpers.mjs';

// §20 — the analysis chat reads as a conversation.
//
// Production showed what it read as instead: the same PDF failure three times over, for a
// folder that had been repaired days earlier, on an analysis that was approved and closed.
// Above it sat the successful PDF card, so the story ran succeeded-then-failed-three-times.
// The failure text was English with an HTTP status and an internal folder name in it, inside
// a Portuguese interface. And the user's own turns were missing entirely — the assistant's
// first line answered a request that appeared nowhere.
//
// These are the four rules that fixes it, tested on the pure functions the server applies
// before the chat ever sees the trail.

const entry = (kind, at, data = {}, pathLetter = 'a') => ({ at, kind, pathLetter, data });

describe('§20 the chat is what is true now, not everything that was ever true', () => {
  it('drops a failure once the thing it was about is in good order', async () => {
    const { resolveFailures } = await loadTsModule('src/lib/workflow/failures.ts');
    const kept = resolveFailures([
      entry('event:version_set_final', 1000),
      entry('event:pdf_conversion_failed', 2000, { message: 'Could not create the folder "X" (HTTP 404).' }),
      entry('conversion', 3000, { conversionId: 'c1', state: 'pronto' }),
    ]);
    assert.equal(
      kept.filter((e) => e.kind === 'event:pdf_conversion_failed').length,
      0,
      'a conversion that later succeeded must not still be reported as failed',
    );
    assert.equal(kept.length, 2);
  });

  it('keeps a failure that nothing has fixed', async () => {
    const { resolveFailures } = await loadTsModule('src/lib/workflow/failures.ts');
    const kept = resolveFailures([
      entry('event:version_set_final', 1000),
      entry('event:pdf_conversion_failed', 2000, { message: 'PDF conversion failed (HTTP 500).' }),
    ]);
    assert.equal(kept.filter((e) => e.kind === 'event:pdf_conversion_failed').length, 1);
  });

  it('drops a failure that happened AFTER the success it no longer contradicts', async () => {
    // The production case exactly: the PDF was produced, three retries then failed on a
    // stale folder id, and the finished PDF sat on screen above three complaints about it.
    const { resolveFailures } = await loadTsModule('src/lib/workflow/failures.ts');
    const message = 'Could not create the folder "Resumo documental" (HTTP 404).';
    const kept = resolveFailures([
      entry('conversion', 1000, { conversionId: 'c1', state: 'pronto_para_revisao' }),
      entry('event:pdf_conversion_failed', 2000, { message }),
      entry('event:pdf_conversion_failed', 3000, { message }),
      entry('event:pdf_conversion_failed', 4000, { message }),
    ]);
    assert.deepEqual(
      kept.map((e) => e.kind),
      ['conversion'],
      'a PDF that exists and is healthy is not also a PDF that failed to convert',
    );
  });

  it('keeps the failure while the conversion itself is in error', async () => {
    const { resolveFailures } = await loadTsModule('src/lib/workflow/failures.ts');
    const kept = resolveFailures([
      entry('conversion', 1000, { conversionId: 'c1', state: 'erro' }),
      entry('event:pdf_conversion_failed', 2000, { message: 'PDF conversion failed (HTTP 500).' }),
    ]);
    assert.equal(kept.filter((e) => e.kind === 'event:pdf_conversion_failed').length, 1);
  });

  it('folds retries of one failure into one message that counts them', async () => {
    const { resolveFailures } = await loadTsModule('src/lib/workflow/failures.ts');
    const message = 'Could not create the folder "Resumo documental" (HTTP 404).';
    const kept = resolveFailures([
      entry('event:pdf_conversion_failed', 1000, { message }),
      entry('event:pdf_conversion_failed', 2000, { message }),
      entry('event:pdf_conversion_failed', 3000, { message }),
    ]);
    assert.equal(kept.length, 1, 'three attempts at one thing are one thing that went wrong');
    assert.equal(kept[0].data.repeated, 3);
    assert.equal(kept[0].at, 3000, 'the surviving message is dated by the latest attempt');
  });

  it('does not merge two genuinely different failures', async () => {
    const { resolveFailures } = await loadTsModule('src/lib/workflow/failures.ts');
    const kept = resolveFailures([
      entry('event:pdf_conversion_failed', 1000, { message: 'A (HTTP 500).' }),
      entry('event:pdf_conversion_failed', 2000, { message: 'B (HTTP 507).' }),
    ]);
    assert.equal(kept.length, 2);
  });
});

describe('§20 failures are spoken in Portuguese, without the plumbing', () => {
  it('says the cause, never the raw text', async () => {
    const { eventChatSentence } = await loadTsModule('src/lib/workflow/events.ts');
    const sentence = eventChatSentence(
      'pdf_conversion_failed',
      { message: 'Could not create the folder "Resumo documental — PPRC (4ZAypg)" (HTTP 404).' },
      'summary',
    );
    assert.ok(!/HTTP|Could not|404|4ZAypg/.test(sentence), `leaked internals: ${sentence}`);
    assert.match(sentence, /pasta da biblioteca no OneDrive/);
    assert.match(sentence, /Defini\u00e7\u00f5es/, 'a failure the user can act on must say what to do');
  });

  it('states the retry count once, inside the same sentence', async () => {
    const { eventChatSentence } = await loadTsModule('src/lib/workflow/events.ts');
    const sentence = eventChatSentence(
      'pdf_conversion_failed',
      { message: 'PDF conversion failed (HTTP 500).', repeated: 3 },
      'summary',
    );
    assert.match(sentence, /Tentei 3 vezes/);
  });

  it('degrades honestly rather than falling back to English', async () => {
    const { eventChatSentence } = await loadTsModule('src/lib/workflow/events.ts');
    const sentence = eventChatSentence('error', { step: 'run', message: 'ENOSPC: no space left' }, 'summary');
    assert.match(sentence, /erro t\u00e9cnico/);
    assert.ok(!/ENOSPC/.test(sentence));
  });
});

describe('§20 the user has turns of their own', () => {
  it('opens with the request the assistant is answering', async () => {
    const { addUserVoice } = await loadTsModule('src/lib/workflow/conversation.ts');
    const out = addUserVoice([
      entry('event:created', 5000, { mainDocumentName: 'PPRC.pdf', relatedSelected: 2, hasInstructions: true }),
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].kind, 'user_said');
    assert.ok(out[0].at < out[1].at, 'the request must precede the reply');
    assert.match(out[0].data.text, /PPRC\.pdf/);
    assert.match(out[0].data.text, /2 documento/);
    assert.match(out[0].data.text, /instru\u00e7\u00f5es/);
  });

  it('says a many-click decision once, with the counts', async () => {
    const { addUserVoice } = await loadTsModule('src/lib/workflow/conversation.ts');
    const out = addUserVoice([
      entry('event:document_confirmed', 1000, { documentId: 'd1' }),
      entry('event:document_confirmed', 1100, { documentId: 'd2' }),
      entry('event:document_excluded', 1200, { documentId: 'd3' }),
      entry('event:run_started', 2000),
    ]);
    const said = out.filter((e) => e.kind === 'user_said');
    assert.equal(said.length, 1, 'three clicks are one decision, said once');
    assert.match(said[0].data.text, /2 documento\(s\) e exclu\u00ed 1/);
    assert.equal(said[0].at, 1200, 'timed at the moment the decision was complete');
  });

  it('voices item review as the user, not as the app', async () => {
    const { addUserVoice } = await loadTsModule('src/lib/workflow/conversation.ts');
    const out = addUserVoice([
      entry('event:item_decided', 1000, { itemId: 'i1', decision: 'accepted' }),
      entry('event:item_decided', 1100, { itemId: 'i2', decision: 'rejected' }),
    ]);
    const said = out.filter((e) => e.kind === 'user_said');
    assert.equal(said.length, 1);
    assert.match(said[0].data.text, /aceitei 1 item\(ns\) e rejeitei 1/);
  });

  it('leaves a trail with no user decisions in it untouched', async () => {
    const { addUserVoice } = await loadTsModule('src/lib/workflow/conversation.ts');
    const input = [entry('event:run_started', 1000), entry('event:run_completed', 2000, { accepted: 4 })];
    assert.deepEqual(addUserVoice(input), input);
  });
});
