'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';

import { previewKindOf, previewModeLabel, previewModesFor, type PreviewMode } from '@/lib/preview-modes';

import { EmailRendition, ExtractionRendition, SourceText } from './renditions';

// Looking at a document without leaving what you were doing. Two ways to see it: one meant
// to be READ, and one showing the file as it actually is — what those two are depends on
// the kind, which is what `previewModesFor` decides.
//
// This is shared on purpose. The chat opens it to justify a citation; the wizard's document
// picker opens it to answer "is this the right file?" before an analysis is committed to it.
// One component means the answer to "what does the app think is in this document" is the
// same in both places — including the cases where the answer is "nothing yet".

export function highlightExcerpt(text: string, excerpt?: string): ReactNode {
  if (!excerpt) return text;
  // Build a whitespace-flexible, accent/case-insensitive pattern from the excerpt's words
  // and match it against the ORIGINAL text — so the <mark> lands on the exact passage the
  // citation refers to, regardless of line wrapping or spacing differences.
  const words = excerpt
    .trim()
    .split(/\s+/)
    .slice(0, 40)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length === 0) return text;
  const mark = (source: string, match: RegExpExecArray) => (
    <>
      {source.slice(0, match.index)}
      <mark className="rounded bg-accent-soft px-0.5 text-ink0">{match[0]}</mark>
      {source.slice(match.index + match[0].length)}
    </>
  );
  try {
    const pattern = new RegExp(words.join('[\\s\\u00A0]+'), 'iu');
    const match = pattern.exec(text);
    if (match) return mark(text, match);
    // Fallback: try the first half of the excerpt (OCR/extraction may diverge mid-way).
    const half = new RegExp(words.slice(0, Math.max(3, Math.floor(words.length / 2))).join('[\\s\\u00A0]+'), 'iu');
    const m2 = half.exec(text);
    return m2 ? mark(text, m2) : text;
  } catch {
    return text;
  }
}

type DocumentDetail = {
  document: { name: string; title: string; mime: string };
  pages: Array<{ page: number; text: string }>;
};

export function DocumentPreview({
  documentId,
  page,
  excerpt,
  frameClassName = 'h-[60vh] min-h-[22rem]',
  showTitle = true,
}: {
  documentId: string;
  /** The cited page, when this preview is justifying a citation. */
  page?: number;
  /** The cited passage, highlighted in the text view. */
  excerpt?: string;
  /** Height of the PDF frame — the chat and the picker have different room. */
  frameClassName?: string;
  /** Off where the surface already names the document, so the page gets that height instead. */
  showTitle?: boolean;
}) {
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [view, setView] = useState<PreviewMode | null>(null);
  // A document only has a PDF once it has been read: an unindexed upload, or a format the
  // app cannot render, answers 409. Probing beforehand is what stops the frame from showing
  // a raw JSON error where the document should be.
  const [hasPdf, setHasPdf] = useState<boolean | null>(null);
  const targetRef = useRef<HTMLDivElement>(null);

  const pdfUrl = `/api/library/documents/${documentId}/download?inline=1&as=pdf`;
  const originalUrl = `/api/library/documents/${documentId}/download?inline=1`;

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setHasPdf(null);
    setView(null);
    void fetch(`/api/library/documents/${documentId}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || !d.ok) return;
        setDoc(d);
        const modes = previewModesFor(previewKindOf(d.document.name, d.document.mime || ''));
        // A citation opens on the text, whatever the kind — the point of following one is
        // to land on the passage, not on a picture of the page it is in.
        setView(page && modes.includes('texto') ? 'texto' : modes[0]);
      })
      .catch(() => {});
    void fetch(pdfUrl, { method: 'HEAD' })
      .then((r) => !cancelled && setHasPdf(r.ok))
      .catch(() => !cancelled && setHasPdf(false));
    return () => {
      cancelled = true;
    };
  }, [documentId, page, pdfUrl]);

  useEffect(() => {
    if (doc && view === 'texto' && page) setTimeout(() => targetRef.current?.scrollIntoView({ block: 'start' }), 60);
  }, [doc, page, view]);

  if (!doc || !view) return <p className="m-0 text-base ui-text-muted">A carregar…</p>;

  const kind = previewKindOf(doc.document.name, doc.document.mime || '');
  const modes = previewModesFor(kind);
  const hasText = doc.pages.some((p) => p.text.trim());
  // Only a kind whose reading view IS the PDF can lose it. An e-mail or an extraction never
  // offered one, so a missing PDF says nothing about them.
  const pdfMissing = modes[0] === 'pdf' && hasPdf === false;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {showTitle ? (
          <p className="m-0 min-w-0 truncate text-base font-medium text-ink0">
            {doc.document.title || doc.document.name}
          </p>
        ) : (
          <span />
        )}
        {pdfMissing ? null : (
          <div className="flex gap-1">
            {modes.map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setView(mode)}
                className={`rounded-md px-2.5 py-1 text-sm ${
                  view === mode ? 'bg-accent-soft font-medium text-accent-strong' : 'ui-btn-secondary'
                }`}
              >
                {previewModeLabel(mode, kind, Boolean(excerpt))}
              </button>
            ))}
          </div>
        )}
      </div>

      {pdfMissing && !hasText ? (
        <p className="ui-soft-panel m-0 rounded-lg p-4 text-base ui-text-muted">
          Este documento ainda não foi lido — não há PDF nem texto para mostrar. Processe-o na
          Biblioteca para o poder pré-visualizar e citar.
        </p>
      ) : view === 'imagem' ? (
        // The image itself, contained rather than cropped, on a neutral field so a scan with
        // a white background still reads as a sheet of paper.
        <div className={`${frameClassName} ui-soft-panel grid w-full place-items-center overflow-auto rounded-md p-3`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a library file streamed
              through our own API, not a build-time asset the optimiser can reach. */}
          <img src={originalUrl} alt={doc.document.name} className="max-h-full max-w-full object-contain" />
        </div>
      ) : view === 'mensagem' ? (
        <EmailRendition documentId={documentId} className={frameClassName} />
      ) : view === 'dados' ? (
        <ExtractionRendition url={originalUrl} className={frameClassName} />
      ) : view === 'fonte' ? (
        <SourceText url={originalUrl} className={frameClassName} json={kind === 'extraction'} />
      ) : view === 'pdf' && hasPdf !== false ? (
        <iframe
          // FitV puts the page top-to-bottom in the frame and navpanes=0 keeps the viewer's
          // thumbnail rail closed — in a half-width panel that rail costs more than it gives.
          src={`${pdfUrl}#page=${page || 1}&view=FitV&navpanes=0`}
          title={doc.document.name}
          className={`${frameClassName} w-full rounded-md border-0 bg-white`}
        />
      ) : (
        <div className="grid gap-3">
          {pdfMissing ? (
            <p className="m-0 text-sm ui-text-muted">
              Sem versão PDF para mostrar — segue o texto que a aplicação extraiu.
            </p>
          ) : null}
          {doc.pages.map((p) => (
            <div
              key={p.page}
              ref={p.page === page ? targetRef : undefined}
              className={`rounded-lg p-3 ${p.page === page ? 'ui-soft-panel border border-accent' : ''}`}
            >
              <p className="m-0 mb-1 font-mono text-xs ui-text-muted">página {p.page}</p>
              <p className="m-0 whitespace-pre-wrap text-sm leading-relaxed">
                {p.page === page ? highlightExcerpt(p.text, excerpt) : p.text || <span className="ui-text-muted">(sem texto)</span>}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
