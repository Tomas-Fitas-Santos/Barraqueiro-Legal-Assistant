'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { Route } from 'next';
import type { ReactNode } from 'react';

// The frame all three template editors sit in.
//
// It exists because of three things the editors got wrong in the same way. The app shell
// deliberately never scrolls — the nav is fixed and each page owns its own scroll region —
// and none of the editors declared one, so a template with more fields than fit the window
// simply could not be reached. There was no way back to where you came from. And editing a
// document with no sight of the document is guesswork: you change a heading and find out
// what it did after saving and publishing it to the client's drive.
//
// The preview is now of what is being EDITED, not of what was last published, so looking no
// longer costs a version on the client's OneDrive. The pane is passed in, because what a
// draft looks like is the one thing the three editors genuinely do differently.

/**
 * Where "back" goes.
 *
 * The editor is opened from a file's page in the library, so that is where it should
 * return. The origin is passed in the URL rather than assumed, and validated to be a path
 * on this app — a `from` that could be any string is an open redirect.
 */
function backTarget(from: string | null): { href: Route; label: string } {
  if (from && from.startsWith('/') && !from.startsWith('//')) {
    return { href: from as Route, label: from.startsWith('/library/') ? 'Voltar ao documento' : 'Voltar' };
  }
  return { href: '/library' as Route, label: 'Voltar à Biblioteca' };
}

export function TemplateEditorShell({
  title,
  description,
  preview,
  edited,
  onRevert,
  onSave,
  saving,
  dirty,
  error,
  message,
  saveTarget,
  children,
}: {
  title: string;
  description: string;
  /** The draft, drawn as the thing it will become. */
  preview: ReactNode;
  edited: boolean;
  onRevert?: () => void;
  onSave: () => void;
  saving: boolean;
  dirty: boolean;
  error: string;
  message: string;
  saveTarget?: string;
  children: ReactNode;
}) {
  const back = backTarget(useSearchParams().get('from'));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href={back.href} className="ui-link text-sm">
            ← {back.label}
          </Link>
          <h1 className="mt-1 mb-0 truncate text-3xl font-semibold text-ink0">{title}</h1>
          <p className="mt-1.5 mb-0 text-base ui-text-muted">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {edited && onRevert ? (
            <button type="button" className="ui-btn-secondary rounded-md px-3 py-2 text-sm" onClick={onRevert} disabled={saving}>
              Repor original
            </button>
          ) : null}
          {/* "Guardado" is a STATE, and used to be drawn as a disabled primary button —
              the loudest thing on the page, offering nothing. It is a quiet marker now, and
              the button appears only when there is in fact something to save. */}
          {dirty || saving ? (
            <button
              type="button"
              data-tutorial-target={saveTarget}
              className="ui-btn-primary px-4 text-sm font-medium"
              onClick={onSave}
              disabled={saving}
            >
              {saving ? 'A guardar…' : 'Guardar e publicar'}
            </button>
          ) : (
            <span className="ui-soft-panel rounded-md px-3 py-2 text-sm ui-text-muted">Guardado</span>
          )}
        </div>
      </div>

      {error ? <p className="mb-3 text-base text-danger">{error}</p> : null}
      {message ? <p className="mb-3 text-base text-ink1">{message}</p> : null}

      {/* Two panes, each scrolling on its own. `min-h-0` on both is what makes that work
          inside a flex column that does not scroll. */}
      <div className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-h-0 overflow-y-auto pr-1">{children}</div>
        <div className="hidden min-h-0 flex-col lg:flex">{preview}</div>
      </div>
    </div>
  );
}
