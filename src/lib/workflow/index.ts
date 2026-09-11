// The workflow definition. One module, imported by both the server (which enforces it)
// and the client (which renders it), so there is exactly one description of how an
// analysis behaves.
//
// Anything user-visible about the flow — a phase, a state's meaning, an event's sentence,
// an action, a refusal reason — belongs here and nowhere else.

export * from '@/lib/workflow/actions';
export * from '@/lib/workflow/events';
export * from '@/lib/workflow/facts';
export * from '@/lib/workflow/messages';
export * from '@/lib/workflow/phases';
export * from '@/lib/workflow/resolve';
