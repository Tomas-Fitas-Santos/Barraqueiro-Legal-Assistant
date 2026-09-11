import { EVENTS, eventPhase, isEventKind } from '@/lib/workflow/events';
import { PHASES } from '@/lib/workflow/phases';

// What the chat does with things that went wrong.
//
// A failure is not a permanent record. The chat is a CONVERSATION, and nobody recounts a
// problem they already solved every time they speak. Two rules follow from that, and both
// are applied here rather than in the component, so the server decides once what the chat
// says and a test can hold it to it:
//
//   1. A failure that has since been fixed leaves the conversation. It stays in Histórico,
//      which is the record. The chat is what is true NOW.
//   2. The same failure retried is ONE failure. Three attempts at the same conversion are
//      one thing that went wrong three times, not three things that went wrong.
//
// Both were visibly broken in production: an approved, closed analysis showed the same PDF
// conversion error three times over, for a folder that had long since been repaired.

export type FeedEntry = { at: number; kind: string; pathLetter: string; data: Record<string, unknown> };

const PHASE_ORDER = new Map(PHASES.map((phase, index) => [phase.key, index]));

function phaseIndex(entry: FeedEntry): number {
  if (!entry.kind.startsWith('event:')) return -1;
  const phase = eventPhase(entry.kind.slice(6), entry.data);
  return phase ? (PHASE_ORDER.get(phase) ?? -1) : -1;
}

function isFailure(entry: FeedEntry): boolean {
  if (!entry.kind.startsWith('event:')) return false;
  const kind = entry.kind.slice(6);
  return isEventKind(kind) && EVENTS[kind].severity === 'error';
}

/**
 * The signature a repeat shares. Retries of one operation produce the same kind and the
 * same message, moments apart; two genuinely different failures do not.
 */
function signature(entry: FeedEntry): string {
  const detail = entry.data;
  return [entry.kind, entry.pathLetter, String(detail.message || ''), String(detail.step || detail.phase || '')].join(
    '|',
  );
}

/**
 * What the analysis looks like NOW, which is the only thing that decides whether a past
 * failure is still worth saying.
 *
 * Deliberately not "did something succeed after it": the production case that prompted all
 * of this had the successful conversion FIRST and three failures after it, so an
 * order-based test kept reporting a broken PDF while the finished PDF sat on screen above
 * the complaint. The question is whether the thing the failure was about is in good order
 * today, not whether the events happen to be in a flattering sequence.
 */
type Standing = { furthestPhase: number; conversionHealthy: boolean };

function standing(feed: FeedEntry[]): Standing {
  let furthestPhase = -1;
  let conversionHealthy = false;
  for (const entry of feed) {
    if (entry.kind === 'conversion') {
      conversionHealthy = String(entry.data.state || '') !== 'erro';
      furthestPhase = Math.max(furthestPhase, PHASE_ORDER.get('pdf') ?? -1);
      continue;
    }
    if (entry.kind === 'version') {
      furthestPhase = Math.max(furthestPhase, PHASE_ORDER.get('documento') ?? -1);
      continue;
    }
    if (!entry.kind.startsWith('event:')) continue;
    const kind = entry.kind.slice(6);
    if (!isEventKind(kind) || EVENTS[kind].severity === 'error') continue;
    furthestPhase = Math.max(furthestPhase, phaseIndex(entry));
  }
  return { furthestPhase, conversionHealthy };
}

function wasResolved(failure: FeedEntry, now: Standing): boolean {
  if (failure.kind === 'event:pdf_conversion_failed') return now.conversionHealthy;
  const failedAt = phaseIndex(failure);
  // Anything else is settled once the work has moved past the phase it failed in.
  return failedAt >= 0 && now.furthestPhase > failedAt;
}

/**
 * Drop failures that no longer describe anything true, and fold retries of the same failure
 * into a single entry carrying how many times it happened.
 */
export function resolveFailures(feed: FeedEntry[]): FeedEntry[] {
  const now = standing(feed);
  const kept: FeedEntry[] = [];
  for (let i = 0; i < feed.length; i += 1) {
    const entry = feed[i];
    if (!isFailure(entry)) {
      kept.push(entry);
      continue;
    }
    if (wasResolved(entry, now)) continue;

    const previous = kept.length > 0 ? kept[kept.length - 1] : null;
    if (previous && isFailure(previous) && signature(previous) === signature(entry)) {
      // Keep the LATEST attempt's time — "this is still failing, as of now".
      kept[kept.length - 1] = {
        ...entry,
        data: { ...entry.data, repeated: Number(previous.data.repeated || 1) + 1 },
      };
      continue;
    }
    kept.push(entry);
  }
  return kept;
}
