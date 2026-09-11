import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="m-0 text-3xl font-semibold text-ink0">{title}</h1>
        {description ? <p className="mt-1.5 mb-0 text-base ui-text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-3">{actions}</div> : null}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`ui-panel rounded-xl p-7 ${className}`}>{children}</div>;
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="ui-soft-panel flex flex-col items-center justify-center rounded-xl px-8 py-12 text-center">
      <p className="m-0 text-lg font-medium text-ink0">{title}</p>
      {description ? <p className="mt-1.5 mb-0 text-base ui-text-muted">{description}</p> : null}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
}) {
  // A <div>, NOT a wrapping <label>: a label wrapping its children forwards every click inside
  // the field to the first form control, so clicking empty space or the hint next to a file
  // input opened the file dialog, and clicking a search result re-focused the text box instead
  // of selecting. The label associates explicitly via htmlFor when a control id is provided.
  return (
    <div className="grid gap-2">
      <label htmlFor={htmlFor} className="text-base font-medium text-ink1">
        {label}
      </label>
      {children}
      {hint ? <span className="text-sm ui-text-muted">{hint}</span> : null}
    </div>
  );
}
