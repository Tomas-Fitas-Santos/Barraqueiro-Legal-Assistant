'use client';

import { CircleHelp } from 'lucide-react';

import { useHelpDrawer } from '@/components/help/help-provider';
import { helpContext, type HelpContextId } from '@/lib/help-contexts';

/** Kept under its original filename so callers migrate without a flag day. */
export function ContextHelpLink({ context, label, className = '' }: { context: HelpContextId; label?: string; className?: string }) {
  const { openHelp } = useHelpDrawer();
  const definition = helpContext(context);
  const accessible = label || `Ajuda: ${definition.label}`;

  return <button type="button" data-tutorial-utility="help" onClick={(event) => openHelp(context, event.currentTarget)} aria-label={accessible} title={accessible} className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border-0 bg-transparent text-accent-strong hover:bg-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${label ? 'px-2 py-1 text-sm font-medium' : 'p-1'} ${className}`}><CircleHelp aria-hidden="true" className="h-4 w-4" />{label ? <span>{label}</span> : null}</button>;
}
