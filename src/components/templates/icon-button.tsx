'use client';

import type { ReactNode } from 'react';

/**
 * A button whose whole content is one glyph.
 *
 * The label is not decoration: with no text in the button it is the only thing naming the
 * action, for a screen reader and for the tooltip alike. A disabled one keeps its label,
 * because the reason it is disabled is usually what the reader wants to know.
 */
export function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="ui-btn-secondary ui-btn-icon"
    >
      {children}
    </button>
  );
}
