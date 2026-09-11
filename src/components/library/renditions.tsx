'use client';

import { useEffect, useState } from 'react';

import { ExtractionItemCard } from '@/components/analyses/extraction-item-card';
import { fieldsForKind } from '@/lib/extraction-fields';

// Presentations for the kinds of file whose PDF was never the point.
//
// An e-mail and an extraction were both previewed as a PDF of a text rendering — two
// conversions between the reader and the thing they were checking. What someone opens an
// e-mail preview to see is who it went to and whether the attachment is really there; what
// someone opens an extraction to see is which fields the agent filled and what it cited.
// Neither survives being flattened into a page image.

function useJson<T>(url: string): { data: T | null; error: string } {
  const [state, setState] = useState<{ data: T | null; error: string }>({ data: null, error: '' });
  useEffect(() => {
    let cancelled = false;
    setState({ data: null, error: '' });
    void fetch(url)
      .then(async (r) => {
        const body = await r.json();
        if (cancelled) return;
        if (!r.ok || body.ok === false) setState({ data: null, error: body.error || 'Não foi possível ler o ficheiro.' });
        else setState({ data: body as T, error: '' });
      })
      .catch(() => !cancelled && setState({ data: null, error: 'Não foi possível ler o ficheiro.' }));
    return () => {
      cancelled = true;
    };
  }, [url]);
  return state;
}

function Loading() {
  return <p className="m-0 text-base ui-text-muted">A carregar…</p>;
}

// --- e-mail ------------------------------------------------------------------------------

type EmailPayload = {
  email: {
    from: string;
    to: string;
    cc: string;
    date: string;
    subject: string;
    bodyText: string;
    attachments: Array<{ name: string; mime: string; size: number; inline: boolean }>;
  };
};

function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function EmailRendition({ documentId, className }: { documentId: string; className: string }) {
  const { data, error } = useJson<EmailPayload>(`/api/library/documents/${documentId}/email`);
  if (error) return <p className="ui-soft-panel m-0 rounded-lg p-4 text-base ui-text-muted">{error}</p>;
  if (!data) return <Loading />;
  return <EmailMessage email={data.email} className={className} />;
}

/**
 * A parsed message, drawn. Separate from the fetching above because the e-mail template
 * editor previews a draft that has no document to fetch — and both must look identical, or
 * the editor is not showing what the client will receive.
 */
export function EmailMessage({ email, className }: { email: EmailPayload['email']; className: string }) {
  const attached = email.attachments.filter((a) => !a.inline);
  const inline = email.attachments.length - attached.length;

  return (
    <div className={`${className} w-full overflow-y-auto rounded-md border border-hair p-4`}>
      <p className="m-0 mb-3 text-lg font-medium text-ink0">{email.subject || '(sem assunto)'}</p>
      <dl className="m-0 mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {[
          ['De', email.from],
          ['Para', email.to],
          ['Cc', email.cc],
          ['Data', email.date],
        ]
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="m-0 ui-text-muted">{label}</dt>
              <dd className="m-0 min-w-0 break-words text-ink1">{value}</dd>
            </div>
          ))}
      </dl>
      <p className="m-0 whitespace-pre-wrap border-t border-hair pt-4 text-sm leading-relaxed">
        {email.bodyText || <span className="ui-text-muted">(sem corpo de mensagem)</span>}
      </p>
      {attached.length || inline ? (
        <div className="mt-4 border-t border-hair pt-3">
          <p className="m-0 mb-2 text-sm font-medium text-ink1">Anexos</p>
          <ul className="m-0 grid list-none gap-1 p-0 text-sm">
            {attached.map((a) => (
              <li key={a.name} className="ui-text-muted">
                {a.name} <span className="font-mono text-xs">— {a.mime}, {bytes(a.size)}</span>
              </li>
            ))}
            {/* Counted, not named: a signature logo is not an attachment anybody sent. */}
            {inline ? <li className="ui-text-muted">{inline} imagem(ns) incorporada(s) na mensagem</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// --- extraction --------------------------------------------------------------------------

type ExtractionExport = {
  schema?: string;
  analysis?: { typeLabel?: string };
  mainDocument?: { documentId?: string; name?: string } | null;
  relatedDocuments?: Array<{ documentId?: string; name: string; relationType: string; status: string }>;
  extraction?: { label?: string; acceptedCount?: number; rejectedCount?: number; fields?: Array<{ key: string; label: string }> } | null;
  items?: Array<{
    itemId: string;
    kind: string;
    accepted: boolean;
    rejectionReason?: string;
    payload: Record<string, unknown>;
  }>;
};

/** The same shape the review screen shows — because it is the same question being asked. */
export function ExtractionRendition({ url, className }: { url: string; className: string }) {
  const { data, error } = useJson<ExtractionExport>(url);
  if (error) return <p className="ui-soft-panel m-0 rounded-lg p-4 text-base ui-text-muted">{error}</p>;
  if (!data) return <Loading />;
  if (!data.schema?.startsWith('legal-assistant/analysis-export')) {
    return (
      <p className="ui-soft-panel m-0 rounded-lg p-4 text-base ui-text-muted">
        Este JSON não é um registo de análise — veja-o em JSON.
      </p>
    );
  }

  const items = data.items || [];
  const accepted = items.filter((i) => i.accepted);
  const rejected = items.filter((i) => !i.accepted);
  // The fields the extraction was MADE with, so an old record reads as what it was even
  // after the extraction template changed underneath it.
  const stored = data.extraction?.fields || [];
  // The export names its documents; without that a citation would read as an opaque id.
  const names = new Map<string, string>();
  if (data.mainDocument?.documentId) names.set(data.mainDocument.documentId, data.mainDocument.name || '');
  for (const d of data.relatedDocuments || []) if (d.documentId) names.set(d.documentId, d.name);
  const sourceName = (id: string) => names.get(id) || id;

  return (
    <div className={`${className} w-full overflow-y-auto rounded-md border border-hair p-4`}>
      <p className="m-0 text-lg font-medium text-ink0">{data.analysis?.typeLabel || 'Análise'}</p>
      <p className="mt-1 mb-4 text-sm ui-text-muted">
        {[data.mainDocument?.name, data.extraction?.label].filter(Boolean).join(' · ')}
      </p>

      {data.relatedDocuments?.length ? (
        <div className="mb-4">
          <p className="m-0 mb-1 text-sm font-medium text-ink1">Documentos relacionados</p>
          <ul className="m-0 grid list-none gap-1 p-0 text-sm ui-text-muted">
            {data.relatedDocuments.map((d) => (
              <li key={d.name}>
                {d.name} — {d.relationType} ({d.status})
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Section title="Validados" items={accepted} fields={stored} sourceName={sourceName} />
      <Section title="Rejeitados pelos validadores" items={rejected} fields={stored} sourceName={sourceName} />
    </div>
  );
}

function Section({
  title,
  items,
  fields,
  sourceName,
}: {
  title: string;
  items: NonNullable<ExtractionExport['items']>;
  fields: Array<{ key: string; label: string }>;
  sourceName: (id: string) => string;
}) {
  return (
    <div className="mt-4 border-t border-hair pt-3">
      <p className="m-0 mb-2 text-sm font-medium text-ink1">
        {title} ({items.length})
      </p>
      {items.length === 0 ? <p className="m-0 text-sm ui-text-muted">(nenhum)</p> : null}
      <div className="grid gap-3">
        {items.map((item) => (
          <ExtractionItemCard
            key={item.itemId}
            item={item}
            // `content` has its own place above the grid, so it must not also appear inside it.
            fields={(fields.length ? fields.map((f) => [f.key, f.label] as [string, string]) : fieldsForKind(item.kind))
              .filter(([key]) => key !== 'content')}
            sourceName={sourceName}
            renderValue={(_field, value) => value}
          />
        ))}
      </div>
    </div>
  );
}

// --- the file as it really is ------------------------------------------------------------

/** The raw bytes as text. For an extraction the JSON IS the record, so it is a real view. */
export function SourceText({ url, className, json }: { url: string; className: string; json: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setText(null);
    void fetch(url)
      .then((r) => r.text())
      .then((body) => {
        if (cancelled) return;
        if (!json) return setText(body);
        try {
          setText(JSON.stringify(JSON.parse(body), null, 2));
        } catch {
          setText(body);
        }
      })
      .catch(() => !cancelled && setError('Não foi possível ler o ficheiro.'));
    return () => {
      cancelled = true;
    };
  }, [url, json]);

  if (error) return <p className="ui-soft-panel m-0 rounded-lg p-4 text-base ui-text-muted">{error}</p>;
  if (text === null) return <Loading />;
  return (
    <pre className={`${className} m-0 w-full overflow-auto rounded-md border border-hair p-4 font-mono text-xs leading-relaxed`}>
      {text}
    </pre>
  );
}
