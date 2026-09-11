import { msg } from '@/lib/workflow/messages';
import type { FeedEntry } from '@/lib/workflow/failures';

// Making the trail read as a conversation rather than as a log of what the app did.
//
// The workflow is deterministic, so the exchange is a fixed script — the same messages in
// the same order every time, only the names and counts differing. What was missing was one
// half of it: the user's own turns. The chat opened with the assistant answering a request
// nobody had made, and the decisions that drive the whole workflow — which documents to
// use, which items to keep — happened in silence because voicing them one event at a time
// would have buried everything else.
//
// So they are voiced ONCE, consolidated, in the user's own words. Same rule as errors: one
// message for one decision, however many rows the decision produced.

const SYNTHETIC_TIME_OFFSET = 1;

function userEntry(at: number, pathLetter: string, text: string): FeedEntry {
  return { at, kind: 'user_said', pathLetter, data: { text } };
}

/** Collapse a run of same-kind events into the single sentence the user would have said. */
function decisionSentence(kinds: string[]): string {
  const confirmed = kinds.filter((k) => k === 'event:document_confirmed').length;
  const excluded = kinds.filter((k) => k === 'event:document_excluded').length;
  if (confirmed === 0 && excluded === 0) return '';
  if (excluded === 0) return msg('chat.user.documents.confirmed', { n: confirmed });
  if (confirmed === 0) return msg('chat.user.documents.excluded', { n: excluded });
  return msg('chat.user.documents.both', { confirmed, excluded });
}

export function addUserVoice(feed: FeedEntry[]): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (let i = 0; i < feed.length; i += 1) {
    const entry = feed[i];

    // The opening request. Without it the assistant's first line answers nobody.
    if (entry.kind === 'event:created') {
      const detail = entry.data;
      let text = msg('chat.user.request', { document: String(detail.mainDocumentName || 'o documento') });
      if (Number(detail.relatedSelected || 0) > 0) {
        text += msg('chat.user.request.related', { n: Number(detail.relatedSelected) });
      }
      if (detail.hasInstructions) text += msg('chat.user.request.instructions');
      out.push(userEntry(entry.at - SYNTHETIC_TIME_OFFSET, entry.pathLetter, text));
      out.push(entry);
      continue;
    }

    if (entry.kind === 'event:document_confirmed' || entry.kind === 'event:document_excluded') {
      const run: FeedEntry[] = [entry];
      while (
        i + 1 < feed.length &&
        (feed[i + 1].kind === 'event:document_confirmed' || feed[i + 1].kind === 'event:document_excluded')
      ) {
        i += 1;
        run.push(feed[i]);
      }
      const text = decisionSentence(run.map((r) => r.kind));
      // Timed at the LAST decision: the sentence is what the user had decided by then.
      if (text) out.push(userEntry(run[run.length - 1].at, entry.pathLetter, text));
      continue;
    }

    if (entry.kind === 'event:item_decided') {
      const run: FeedEntry[] = [entry];
      while (i + 1 < feed.length && feed[i + 1].kind === 'event:item_decided') {
        i += 1;
        run.push(feed[i]);
      }
      const accepted = run.filter((r) => String(r.data.decision || '') === 'accepted').length;
      const rejected = run.length - accepted;
      out.push(
        userEntry(
          run[run.length - 1].at,
          entry.pathLetter,
          rejected === 0
            ? msg('chat.user.items.accepted', { n: accepted })
            : msg('chat.user.items.both', { accepted, rejected }),
        ),
      );
      continue;
    }

    out.push(entry);
  }
  return out;
}
