'use client';

import { type ReactNode, useEffect } from 'react';

/**
 * Last-resort isolation boundary for training mode.
 *
 * Shared components receive tutorial data and actions through props. If a future refactor
 * accidentally leaves a live API read or mutation inside one of them, fail closed before
 * the request leaves the browser. Tutorial-run state and its immutable snapshot are the
 * only API namespace available while the training application is mounted.
 */
function blockedApiUrl(raw: string | URL): URL | null {
  const url = new URL(String(raw), window.location.href);
  return url.origin === window.location.origin && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/tutorials/') ? url : null;
}

export function TutorialNetworkGuard({ children }: { children: ReactNode }) {
  useEffect(() => {
    const originalFetch = window.fetch;
    const originalOpen = window.XMLHttpRequest.prototype.open;
    const guardedFetch: typeof window.fetch = (input, init) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const blocked = blockedApiUrl(raw);
      if (blocked) return Promise.reject(new Error(`Tutorial isolation blocked a live application request: ${init?.method || 'GET'} ${blocked.pathname}`));
      return originalFetch(input, init);
    };
    function guardedOpen(this: XMLHttpRequest, method: string, url: string | URL, async = true, username?: string | null, password?: string | null) {
      const blocked = blockedApiUrl(url);
      if (blocked) throw new Error(`Tutorial isolation blocked a live application request: ${method} ${blocked.pathname}`);
      return originalOpen.call(this, method, url, async, username, password);
    }
    window.fetch = guardedFetch;
    window.XMLHttpRequest.prototype.open = guardedOpen;
    return () => {
      if (window.fetch === guardedFetch) window.fetch = originalFetch;
      if (window.XMLHttpRequest.prototype.open === guardedOpen) window.XMLHttpRequest.prototype.open = originalOpen;
    };
  }, []);

  return children;
}
