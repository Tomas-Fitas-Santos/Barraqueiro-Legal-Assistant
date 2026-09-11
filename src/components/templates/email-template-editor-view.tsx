'use client';

import { useCallback, useEffect, useState } from 'react';

import { EmailMessage } from '@/components/library/renditions';
import { PreviewControls, usePreviewSubject, useRefreshMode } from '@/components/templates/preview-pane';
import { TemplateEditorShell } from '@/components/templates/template-editor-shell';
import { Card, EmptyState, Field } from '@/components/ui/page';

/**
 * The e-mail that delivers an approved PDF.
 *
 * Its subject and body used to be written in the code that builds the draft, so changing a
 * greeting meant a deploy. They are a template like any other now — same registry, same
 * versioning — and small enough to be exactly what they are: two fields and the list of
 * placeholders the app fills in.
 */
export function EmailTemplateEditorView({ templateId }: { templateId: string }) {
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [fields, setFields] = useState<string[]>([]);
  const [edited, setEdited] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [refreshMode, setRefreshMode] = useRefreshMode();
  const { shown, stale, refresh } = usePreviewSubject({ subject, body }, refreshMode);

  const load = useCallback(async () => {
    const data = await fetch(`/api/templates/${templateId}/email`).then((r) => r.json());
    if (!data.ok) {
      setMessage(data.error || 'Não foi possível carregar o template.');
      return;
    }
    setName(data.name);
    setSubject(data.subject);
    setBody(data.body);
    setFields(data.fields);
    setEdited(data.edited);
    setLoaded(true);
    setDirty(false);
  }, [templateId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setMessage('');
    const res = await fetch(`/api/templates/${templateId}/email`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject, body }),
    });
    const data = await res.json();
    setSaving(false);
    if (!data.ok) {
      setMessage(data.error || 'Não foi possível guardar.');
      return;
    }
    setMessage('E-mail guardado e publicado na biblioteca.');
    await load();
  };

  const revert = async () => {
    setSaving(true);
    await fetch(`/api/templates/${templateId}/email`, { method: 'DELETE' });
    setSaving(false);
    setMessage('E-mail reposto na versão da aplicação.');
    await load();
  };

  const preview = (
    <>
      <PreviewControls mode={refreshMode} onMode={setRefreshMode} stale={stale} onRefresh={refresh} />
      <EmailDraftPreview templateId={templateId} draft={shown} />
    </>
  );

  if (!loaded) return <EmptyState title="A carregar…" />;

  return (
    <TemplateEditorShell
      title={name || 'E-mail'}
      description={
        edited
          ? 'Editado por si. A versão da aplicação continua disponível para reposição.'
          : 'Versão da aplicação. Qualquer alteração cria uma nova versão do template.'
      }
      preview={preview}
      edited={edited}
      onRevert={() => void revert()}
      onSave={() => void save()}
      saving={saving}
      dirty={dirty}
      error={''}
      message={message}
    >

      <Card>
        <div className="grid gap-5">
          <Field label="Assunto">
            <input
              className="ui-input"
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                setDirty(true);
              }}
            />
          </Field>
          <Field label="Mensagem">
            <textarea
              className="ui-input min-h-64 font-mono text-sm"
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setDirty(true);
              }}
            />
          </Field>
        </div>
        <p className="mt-5 mb-0 text-sm ui-text-muted">
          Campos preenchidos automaticamente: {fields.map((f) => `{${f}}`).join(', ')}. O PDF aprovado é sempre o anexo
          — o rascunho continua a exigir uma versão final convertida e aprovada.
        </p>
      </Card>
    </TemplateEditorShell>
  );
}

function EmailDraftPreview({
  templateId,
  draft,
}: {
  templateId: string;
  draft: { subject: string; body: string };
}) {
  const [email, setEmail] = useState<Parameters<typeof EmailMessage>[0]['email'] | null>(null);
  const [error, setError] = useState('');
  const key = `${draft.subject}\u0000${draft.body}`;

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/templates/${templateId}/email/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft),
    })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.ok) {
          setEmail(data.email);
          setError('');
        } else {
          setError(data.error || 'Não foi possível pré-visualizar este e-mail.');
        }
      })
      .catch(() => !cancelled && setError('Não foi possível pré-visualizar este e-mail.'));
    return () => {
      cancelled = true;
    };
    // `key` is the draft's content; depending on the object itself would refetch on every
    // keystroke's new identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, key]);

  if (error) return <p className="ui-soft-panel m-0 rounded-lg p-4 text-base ui-text-muted">{error}</p>;
  if (!email) return <p className="m-0 text-base ui-text-muted">A carregar…</p>;
  return <EmailMessage email={email} className="min-h-0 flex-1" />;
}
