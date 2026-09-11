'use client';

import { CircleHelp } from 'lucide-react';
import { usePathname } from 'next/navigation';
import type { MouseEvent } from 'react';

import { useHelpDrawer } from '@/components/help/help-provider';
import {
  helpContext,
  resolveAnalysisHelpContext,
  type HelpAnalysisType,
  type HelpContextId,
} from '@/lib/help-contexts';

const analysisTypeCache = new Map<string, HelpAnalysisType>();

function contextType(context: HelpContextId): HelpAnalysisType | null {
  if (context.startsWith('analysis.summary.') || context === 'analysis.extraction.summary') return 'summary';
  if (context.startsWith('analysis.revision.') || context === 'analysis.extraction.revision') return 'revision';
  return null;
}

function analysisIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/analyses\/([^/]+)(?:\/|$)/);
  if (!match || match[1] === 'new') return null;
  return decodeURIComponent(match[1]);
}

/**
 * Contextual help always renders one of the same sections used on the full Help page.
 *
 * Some older workflow states still expose a generic context such as `analysis.document`.
 * On an analysis page we resolve that context against the current analysis type first, so
 * a Revisão button never sends the user to the Resumo chapter (and vice versa).
 */
export function ContextHelpLink({ context, label, className = '' }: { context: HelpContextId; label?: string; className?: string }) {
  const { openHelp } = useHelpDrawer();
  const pathname = usePathname();
  const definition = helpContext(context);
  const accessible = label || `Ajuda: ${definition.label}`;

  async function handleClick(event: MouseEvent<HTMLButtonElement>) {
    const anchor = event.currentTarget;
    let resolved = context;
    let type = contextType(context);

    if (!type && context.startsWith('analysis.')) {
      const analysisId = analysisIdFromPath(pathname);
      if (analysisId) {
        type = analysisTypeCache.get(analysisId) || null;
        if (!type) {
          try {
            const response = await fetch(`/api/analyses/${encodeURIComponent(analysisId)}`);
            const data = await response.json();
            if (data?.ok && (data.analysis?.type === 'summary' || data.analysis?.type === 'revision')) {
              const fetchedType: HelpAnalysisType = data.analysis.type;
              type = fetchedType;
              analysisTypeCache.set(analysisId, fetchedType);
            }
          } catch {
            // Contextual help must still open even if the analysis refresh fails.
          }
        }
      }
    }

    if (type) resolved = resolveAnalysisHelpContext(context, type);
    openHelp(resolved, anchor);
  }

  return <button type="button" data-tutorial-utility="help" onClick={handleClick} aria-label={accessible} title={accessible} className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border-0 bg-transparent text-accent-strong hover:bg-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${label ? 'px-2 py-1 text-sm font-medium' : 'p-1'} ${className}`}><CircleHelp aria-hidden="true" className="h-4 w-4" />{label ? <span>{label}</span> : null}</button>;
}
