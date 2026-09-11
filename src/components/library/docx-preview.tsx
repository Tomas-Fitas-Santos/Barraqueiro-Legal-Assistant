'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A .docx drawn as the page it is, in the browser.
 *
 * Shared between the analysis chat — where somebody approves a generated document — and the
 * template editors, where somebody is deciding what that document will look like. One
 * component means both are looking at the same rendering of the same bytes.
 *
 * `source` is either a URL to GET, or a body to POST to one. The second form exists for the
 * template editors, whose subject is a block list that has not been saved anywhere yet and
 * so has no address of its own.
 */
export type DocxSource = { url: string } | { url: string; post: unknown };

export function DocxPreview({
  source,
  className = '',
  cacheKey = '',
}: {
  source: DocxSource;
  className?: string;
  /** Bumped to force a re-render when the bytes depend on something outside `source` — the
      letterhead, which the template editor can change without touching the blocks. */
  cacheKey?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useFitToWidth(hostRef, loading);

  const post = 'post' in source ? source.post : undefined;
  // The body is what identifies a draft render, so the effect has to key off its content
  // rather than off an object identity that changes on every keystroke.
  const key = `${source.url}:${cacheKey}:${post === undefined ? '' : JSON.stringify(post)}`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [{ renderAsync }, res] = await Promise.all([
          import('docx-preview'),
          post === undefined
            ? fetch(source.url)
            : fetch(source.url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(post),
              }),
        ]);
        if (!res.ok) throw new Error('render failed');
        const blob = await res.blob();
        if (cancelled || !hostRef.current) return;
        hostRef.current.innerHTML = '';
        await renderAsync(blob, hostRef.current, undefined, {
          className: 'docx',
          inWrapper: true,
          ignoreWidth: false,
          experimental: true,
        });
        if (cancelled) return;
        setError('');
        setLoading(false);
      } catch {
        if (cancelled) return;
        setLoading(false);
        setError('Não foi possível pré-visualizar este documento. Descarregue-o para o abrir no Word.');
      }
    })();
    return () => {
      cancelled = true;
    };
    // `key` stands for the whole of url + body + cacheKey. Listing its parts again would
    // re-render the file on object identity alone, which changes on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div className={`grid ${className}`}>
      {error ? <p className="m-0 mb-2 text-sm text-danger">{error}</p> : null}
      {/* `overflow-auto`, not `overflow-x-auto`: setting one axis forces the other to compute
          to `auto` as well, and the letterhead sits in the header, above the page box. With
          only the horizontal axis named, the top of the logo was clipped with no way to
          scroll to it — the preview cutting off the very mark it exists to show. */}
      <div
        ref={hostRef}
        aria-busy={loading}
        className="docx-host ui-soft-panel min-h-0 overflow-auto rounded-md p-3 text-black"
      />
    </div>
  );
}

/**
 * Scales the rendered page so its width matches the pane.
 *
 * `zoom` rather than `transform: scale()` on purpose: a transform leaves the element's
 * layout size untouched, so the scroll region would still be sized for an unscaled A4 page
 * and the pane would scroll sideways over empty space. Never scaled UP — a page enlarged
 * past 1 would show the document bigger than it prints, which is the kind of small lie a
 * preview must not tell.
 */
function useFitToWidth(hostRef: React.RefObject<HTMLDivElement | null>, loading: boolean) {
  useEffect(() => {
    const host = hostRef.current;
    if (!host || loading) return;
    const fit = () => {
      const page = host.querySelector<HTMLElement>('section.docx');
      const wrapper = host.querySelector<HTMLElement>('.docx-wrapper');
      if (!page || !wrapper) return;
      wrapper.style.zoom = '1';
      const pageWidth = page.getBoundingClientRect().width;
      const available = host.clientWidth - 8;
      if (pageWidth > 0 && available > 0) wrapper.style.zoom = String(Math.min(1, available / pageWidth));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    return () => observer.disconnect();
  }, [hostRef, loading]);
}
