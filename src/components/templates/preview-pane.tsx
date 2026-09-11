'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'legal.templatePreview.refresh';

export type RefreshMode = 'auto' | 'manual';

/**
 * Whether the preview follows the editor on its own, remembered between visits.
 *
 * Overleaf's arrangement, and for its reason: automatic is what you want while writing, and
 * the moment you want to compare against what you had, you want it to hold still.
 */
export function useRefreshMode(): [RefreshMode, (next: RefreshMode) => void] {
  const [mode, setMode] = useState<RefreshMode>('auto');

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'auto' || stored === 'manual') setMode(stored);
  }, []);

  const choose = useCallback((next: RefreshMode) => {
    setMode(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  return [mode, choose];
}

/**
 * The content the preview should currently be showing.
 *
 * `subject` is whatever the editor holds now. What comes back is the last value the preview
 * was told to draw — which in automatic mode trails the subject by a debounce, and in manual
 * mode does not move until `refresh` is called. `stale` is the honest bit: it says the two
 * have diverged, so a held preview can never quietly pass for a current one.
 */
export function usePreviewSubject<T>(subject: T, mode: RefreshMode, delayMs = 600) {
  const [shown, setShown] = useState<T>(subject);
  // Serialised rather than compared by identity: the editors rebuild their state objects on
  // every keystroke, so identity would report a change even where the content is unchanged.
  const subjectKey = JSON.stringify(subject);
  const shownKey = JSON.stringify(shown);
  const subjectRef = useRef(subject);
  subjectRef.current = subject;
  // The editors mount before their template has loaded, so their first subject is an empty
  // one. Debouncing that would render — and in the extraction editor, REJECT — a template
  // nobody wrote. The first change is always the load, never a keystroke, so it applies at
  // once; only from the second does the delay mean anything.
  const settled = useRef(false);

  useEffect(() => {
    if (subjectKey === shownKey) return;
    if (!settled.current) {
      settled.current = true;
      setShown(subjectRef.current);
      return;
    }
    if (mode !== 'auto') return;
    const timer = setTimeout(() => setShown(subjectRef.current), delayMs);
    return () => clearTimeout(timer);
  }, [mode, subjectKey, shownKey, delayMs]);

  const refresh = useCallback(() => setShown(subjectRef.current), []);

  return { shown, stale: subjectKey !== shownKey, refresh };
}

export function PreviewControls({
  mode,
  onMode,
  stale,
  onRefresh,
}: {
  mode: RefreshMode;
  onMode: (next: RefreshMode) => void;
  stale: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <p className="m-0 text-sm ui-text-muted">
        {stale
          ? mode === 'auto'
            ? 'A atualizar…'
            : 'Desatualizada — mostra a versão anterior às suas últimas alterações.'
          : 'Atualizada com o que está a editar. Ainda não foi publicada.'}
      </p>
      <div className="flex items-center gap-1">
        {(['auto', 'manual'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onMode(option)}
            className={`rounded-md px-2.5 py-1 text-sm ${
              mode === option ? 'bg-accent-soft font-medium text-accent-strong' : 'ui-btn-secondary'
            }`}
          >
            {option === 'auto' ? 'Automático' : 'Manual'}
          </button>
        ))}
        <button
          type="button"
          onClick={onRefresh}
          disabled={!stale}
          className="ui-btn-secondary px-2.5 py-1 text-sm"
        >
          Atualizar
        </button>
      </div>
    </div>
  );
}
