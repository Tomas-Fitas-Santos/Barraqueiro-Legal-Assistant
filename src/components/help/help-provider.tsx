'use client';

import { X } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { HelpTopicSection } from '@/components/help/help-topics';
import { helpContext, type HelpContextId } from '@/lib/help-contexts';

type HelpDialogState = { context: HelpContextId; invocation: HTMLElement | null } | null;
type HelpController = { openHelp: (context: HelpContextId, invocation?: HTMLElement | null) => void; closeHelp: () => void };

const HelpDrawerContext = createContext<HelpController | null>(null);

export function HelpProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<HelpDialogState>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const closeHelp = useCallback(() => {
    setState((current) => {
      window.setTimeout(() => current?.invocation?.focus(), 0);
      return null;
    });
  }, []);
  const openHelp = useCallback((context: HelpContextId, invocation: HTMLElement | null = null) => setState({ context, invocation }), []);
  const value = useMemo(() => ({ openHelp, closeHelp }), [openHelp, closeHelp]);
  const topic = state ? helpContext(state.context) : null;

  useEffect(() => {
    if (!topic) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { closeHelp(); return; }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const controls = dialogRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])');
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [topic, closeHelp]);

  return <HelpDrawerContext.Provider value={value}>
    {children}
    {topic ? <div className="fixed inset-0 z-[100] grid place-items-center bg-black/35 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) closeHelp(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`Ajuda — ${topic.label}`} className="ui-panel flex max-h-[min(46rem,calc(100dvh-2rem))] w-full max-w-4xl flex-col overflow-hidden rounded-2xl shadow-2xl">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-line0 px-6 py-4">
          <div>
            <p className="m-0 text-xs font-semibold uppercase tracking-wide text-accent-strong">Ajuda contextual</p>
            <p className="m-0 mt-0.5 text-base ui-text-muted">A mesma explicação disponível na página Ajuda.</p>
          </div>
          <button ref={closeRef} type="button" onClick={closeHelp} aria-label="Fechar Ajuda" className="ui-btn-secondary rounded-md p-2"><X aria-hidden className="h-5 w-5" /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-bg0 p-5" data-help-dialog-topic={topic.section}>
          <HelpTopicSection sectionId={topic.section} highlighted />
        </div>
      </div>
    </div> : null}
  </HelpDrawerContext.Provider>;
}

export function useHelpDrawer() {
  const value = useContext(HelpDrawerContext);
  if (!value) throw new Error('useHelpDrawer must be used inside HelpProvider');
  return value;
}
