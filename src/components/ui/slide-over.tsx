'use client';

import { X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// The panel that slides in over the page from the right, the way an artifact opens in Claude
// or ChatGPT: you inspect or edit the thing without losing where you were.
//
// Production panels render through a portal to <body> because the app shell is
// `overflow-hidden`. A tutorial can instead contain the same panel inside its own positioned
// application viewport, keeping external guidance beside it rather than underneath it.
//
// One component, one width, everywhere a document is previewed, edited or checked against
// its sources — the Library, the analysis chat, the wizard's picker.

// Half the viewport. At that width a page of A4 rendered top-to-bottom still fits across: a
// full-height frame is about 0.71 of its own height wide, which half of any ordinary desktop
// viewport clears.
const MIN_WIDTH = 480;
const WIDTH_KEY = 'legal.slideover.width';

function defaultWidth() {
  return Math.max(MIN_WIDTH, Math.round(window.innerWidth / 2));
}

export function SlideOver({
  open,
  title,
  leading,
  actions,
  onClose,
  dismissible = true,
  modal = true,
  contained = false,
  tutorialTarget,
  children,
}: {
  open: boolean;
  title: ReactNode;
  /** Sits before the title — the back button when the panel is a stack. */
  leading?: ReactNode;
  /** Header buttons, before the close button. */
  actions?: ReactNode;
  onClose: () => void;
  /**
   * Off when the panel holds an unsaved form: a stray click on the backdrop or an Escape
   * meant for a select would throw the user's typing away with nothing to undo it.
   */
  dismissible?: boolean;
  /** Non-modal inspectors leave the page and external tutorial coach operable. */
  modal?: boolean;
  /** Render inside the nearest positioned application viewport instead of over the page. */
  contained?: boolean;
  tutorialTarget?: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setMounted(true);
    const stored = Number(window.localStorage.getItem(WIDTH_KEY) || 0);
    setWidth(stored >= MIN_WIDTH ? stored : defaultWidth());
  }, []);

  // Enter on the next frame so the browser has a chance to paint the closed position first;
  // otherwise the element appears already open and there is no transition to see.
  useEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const close = useCallback(() => {
    setShown(false);
    // Let the exit transition finish before unmounting, or it snaps away.
    window.setTimeout(() => {
      onClose();
      restoreFocusTo.current?.focus?.();
    }, 200);
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissible) {
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab' || !modal || !panelRef.current) return;
      // Keep focus inside the panel: it is a dialog, and tabbing out to the page behind it
      // leaves a keyboard user somewhere they cannot see.
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, iframe, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, dismissible, modal, close]);

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const move = (e: PointerEvent) => {
      setWidth(Math.min(Math.max(window.innerWidth - e.clientX, MIN_WIDTH), window.innerWidth - 120));
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      setWidth((current) => {
        if (current !== null) window.localStorage.setItem(WIDTH_KEY, String(current));
        return current;
      });
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };

  if (!mounted || !open || width === null) return null;

  const panel = (
    <>
      {modal ? <div
        aria-hidden
        onClick={dismissible ? close : undefined}
        className={`fixed inset-0 z-40 bg-black/30 transition-opacity duration-200 motion-reduce:transition-none ${shown ? 'opacity-100' : 'opacity-0'}`}
      /> : null}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={modal}
        aria-label={typeof title === 'string' ? title : 'Painel'}
        style={{ width }}
        className={`ui-panel ${contained ? 'absolute h-full' : 'fixed h-dvh'} right-0 top-0 z-50 flex max-w-[96vw] flex-col rounded-none border-l border-line0 transition-transform duration-200 ease-out motion-reduce:transition-none ${
          shown ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div
          onPointerDown={startResize}
          className="absolute left-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-accent-soft"
          aria-hidden
        />
        <header data-tutorial-target={tutorialTarget} className="flex shrink-0 items-center justify-between gap-3 border-b border-line0 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {leading}
            <p className="m-0 min-w-0 truncate text-base font-medium text-ink0">{title}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            <button
              type="button"
              onClick={close}
              aria-label="Fechar"
              className="ui-btn-secondary rounded-md px-2 py-1 text-sm leading-none"
            >
              <X size={16} aria-hidden />
            </button>
          </div>
        </header>
        {children}
      </div>
    </>
  );
  return contained ? panel : createPortal(panel, document.body);
}

/** Height available to a full-bleed frame inside the panel, below the header and padding. */
export const SLIDE_OVER_FRAME_HEIGHT = 'h-[calc(100dvh-8.5rem)] min-h-[24rem]';
