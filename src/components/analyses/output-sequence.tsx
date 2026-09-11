import type { ReactNode } from 'react';

export type OutputSequenceItem = {
  key: string;
  title: string;
  status: string;
  detail: string;
  action?: ReactNode;
};

/** Word → PDF → e-mail, shared by live analyses and the isolated tutorials. */
export function OutputSequence({ items }: { items: OutputSequenceItem[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {items.map((item, index) => (
        <div key={item.key} className="ui-soft-panel flex min-h-40 flex-col rounded-lg border border-line0 p-4">
          <span className="ui-pill-info mb-2 w-fit rounded-full px-2 py-0.5 text-xs">Passo {index + 1}</span>
          <h3 className="m-0 text-lg font-semibold text-ink0">{item.title}</h3>
          <p className="mt-1 mb-0 text-sm font-medium text-accent-strong">{item.status}</p>
          <p className="mt-2 mb-3 flex-1 text-sm ui-text-muted">{item.detail}</p>
          {item.action}
        </div>
      ))}
    </div>
  );
}
