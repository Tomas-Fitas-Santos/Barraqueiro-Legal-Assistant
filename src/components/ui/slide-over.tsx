'use client';

import { X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// The panel that slides in over the page from the right, the way an artifact opens in
// ChatGPT: you inspect or edit the thing without losing where you were.
//
// Production panels render through a portal to <body> because the app shell is
// `overflow-hidden`. A tutorial can instead contain the SAME panel inside its positioned
// application viewport. That keeps the training UI faithful to production while allowing
// the tutorial coach to remain outside the simulated application.
//
// This is the one shell for every document-like surface: source documents, extraction,
// generated Word, PDF, e-mail and history details.

const MIN_DESKTOP_WIDTH = 480;
const MAX_WIDTH_RATIO = 0.96;
const WIDTH_KEY = 'legal.slideover.width';

type WidthBounds = { min: number; max: number };

/**
 * A document panel must never become a narrow drawer on desktop. Half of the available app
 * width is the minimum useful size for reading an A4 page; users may drag it wider up to
 * almost the full application. On small screens the 96% ceiling wins so the panel still
 * fits instead of overflowing.
 */
function widthBounds(available: number): WidthBounds {
  const safeAvailable = Math.max(1, available);
  const max = Math.max(1, Math.round(safeAvailable * MAX_WIDTH_RATIO));
  const min = Math.min(max, Math.max(MIN_DESKTOP_WIDTH, Math.round(safeAvailable / 2)));
  return { min, max };
}

function clampWidth(value: number, available: number) {
  const { min, max } = widthBounds(available);
  return Math.min(Math.max(value, min), max);
}

function defaultWidth(available: number) {
  return clampWidth(Math.round(available / 2), available);
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

  const availableRect = useCallback(() => {
    if (contained && panelRef.current?.parentElement) {
      return panelRef.current.parentElement.getBoundingClientRect();
    }
    return { left: 0, right: window.innerWidth, width: window.innerWidth } as Pick<DOMRect, 'left' | 'right' | 'width'>;
  }, [contained]);

  useEffect(() => {
    setMounted(true);
    const stored = Number(window.localStorage.getItem(WIDTH_KEY) || 0);
    setWidth(stored > 0 ? clampWidth(stored, window.innerWidth) : defaultWidth(window.innerWidth));
  }, []);

  // Once the panel exists we know the REAL available width. This matters in tutorials:
  // their application canvas can be narrower than the browser window, and its panel must
  // still be exactly the same half-width/resizable component rather than a lookalike.
  useEffect(() => {
    if (!mounted || !open) return;
    const update = () => {
      const available = availableRect().width;
      const stored = Number(window.localStorage.getItem(WIDTH_KEY) || 0);
      setWidth((current) => clampWidth(stored > 0 ? stored : current || defaultWidth(available), available));
    };
    const raf = requestAnimationFrame(update);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', update);
    };
  }, [availableRect, mounted, open]);

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
    const rect = availableRect();
    const move = (e: PointerEvent) => {
      // The panel is anchored to the right edge. In a contained tutorial that edge belongs
      // to the application canvas, not to window.innerWidth.
      setWidth(clampWidth(rect.right - e.clientX, rect.width));
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
        data-slide-over
        role="dialog"
        aria-modal={modal}
        aria-label={typeof title === 'string' ? title : 'Painel'}
        style={{ width }}
        className={`ui-panel ${contained ? 'absolute h-full' : 'fixed h-dvh'} right-0 top-0 z-50 flex max-w-[96%] flex-col rounded-none border-l border-line0 transition-transform duration-200 ease-out motion-reduce:transition-none ${
          shown ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div
          data-slide-over-resize-handle
          onPointerDown={startResize}
          className="absolute left-0 top-0 h-full w-2 cursor-col-resize touch-none hover:bg-accent-soft"
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
