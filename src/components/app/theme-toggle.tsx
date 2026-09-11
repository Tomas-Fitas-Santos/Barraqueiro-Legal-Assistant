'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

const KEY = 'legal-theme-preference-v1';

export function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'night'>('light');

  useEffect(() => {
    const current = document.documentElement.dataset.theme === 'night' ? 'night' : 'light';
    setTheme(current);
  }, []);

  function toggle() {
    const next = theme === 'night' ? 'light' : 'night';
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // ignore storage failures
    }
    setTheme(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === 'night' ? 'Switch to light theme' : 'Switch to dark theme'}
      className="ui-btn-secondary inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
    >
      {theme === 'night' ? <Sun aria-hidden className="h-5 w-5 shrink-0" /> : <Moon aria-hidden className="h-5 w-5 shrink-0" />}
    </button>
  );
}
