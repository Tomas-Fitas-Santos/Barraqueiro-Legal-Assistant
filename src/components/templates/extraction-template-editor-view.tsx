'use client';

import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { IconButton } from '@/components/templates/icon-button';
import { PreviewControls, usePreviewSubject, useRefreshMode } from '@/components/templates/preview-pane';
import { TemplateEditorShell } from '@/components/templates/template-editor-shell';
import { Card, EmptyState, Field } from '@/components/ui/page';

type EditorField = {
  key: string;
  label: string;
  description: string;
  lockedBecause?: string;
};

/**
 * What the agent is asked to extract.
 *
 * The shape of an extraction used to live in the code, so capturing one more thing about a
 * document meant a deploy. Adding a field here changes what the agent looks for on the next
 * run: the description is not documentation, it is the instruction the model receives.
 *
 * What is NOT here is the citation spine — document, page, excerpt, confidence. Every field
 * below is subject to it: the agent may only fill one from the document, and what it cannot
 * support is marked não confirmado rather than presented as fact. A screen that could delete
 * `source_excerpt` would be a screen that could switch off citation checking.
 */
export function ExtractionTemplateEditorView({ templateId }: { templateId: string }) {
  const [name, setName] = useState('');
  const [fields, setFields] = useState<EditorField[]>([]);
  const [edited, setEdited] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [refreshMode, setRefreshMode] = useRefreshMode();
  const { shown, stale, refresh } = usePreviewSubject(fields, refreshMode);

  const load = useCallback(async () => {
    const data = await fetch(`/api/templates/${templateId}/fields`).then((r) => r.json());
    if (!data.ok) {
      setError(data.error || 'Não foi possível carregar o template.');
      return;
    }
    setName(data.name);
    setFields(data.fields);
    setEdited(data.edited);
    setLoaded(true);
    setDirty(false);
  }, [templateId]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = (index: number, patch: Partial<EditorField>) => {
    setFields((current) => current.map((f, i) => (i === index ? { ...f, ...patch } : f)));
    setDirty(true);
  };

  const move = (index: number, by: number) => {
    setFields((current) => {
      const next = [...current];
      const target = index + by;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setDirty(true);
  };

  const remove = (index: number) => {
    setFields((current) => current.filter((_, i) => i !== index));
    setDirty(true);
  };

  const add = () => {
    setFields((current) => [...current, { key: '', label: '', description: '' }]);
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    setError('');
    setMessage('');
    const res = await fetch(`/api/templates/${templateId}/fields`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    const data = await res.json();
    setSaving(false);
    if (!data.ok) {
      setError(data.error || 'Não foi possível guardar.');
      return;
    }
    setMessage('Guardado. A próxima análise passa a extrair estes campos.');
    await load();
  };

  const revert = async () => {
    setSaving(true);
    await fetch(`/api/templates/${templateId}/fields`, { method: 'DELETE' });
    setSaving(false);
    setMessage('Campos repostos na versão da aplicação.');
    await load();
  };

  const preview = (
    <>
      <PreviewControls mode={refreshMode} onMode={setRefreshMode} stale={stale} onRefresh={refresh} />
      <FieldsDraftPreview templateId={templateId} fields={shown} />
    </>
  );

  if (!loaded) return error ? <p className="text-base text-danger">{error}</p> : <EmptyState title="A carregar…" />;

  return (
    <TemplateEditorShell
      title={name}
      description={edited
          ? 'Editado por si. A versão da aplicação continua disponível para reposição.'
          : 'Versão da aplicação. Alterar os campos altera o que o agente procura na próxima análise.'}
      preview={preview}
      edited={edited}
      onRevert={() => void revert()}
      onSave={() => void save()}
      saving={saving}
      dirty={dirty}
      error={error}
      message={message}
    >

      <Card>
        <p className="m-0 text-base">
          Cada campo abaixo é preenchido pelo agente a partir do documento. A descrição é a instrução que o agente
          recebe — é ela que faz um campo novo ser realmente procurado.
        </p>
        <p className="mt-3 mb-0 text-base ui-text-muted">
          A citação (documento, página, excerto e confiança) não se edita aqui: qualquer campo, incluindo os que
          acrescentar, só pode ser preenchido com base no documento. O que o agente não conseguir suportar fica marcado
          como não confirmado, nunca apresentado como facto.
        </p>
      </Card>

      <div className="mt-5 grid gap-4">
        {fields.map((field, index) => (
          <Card key={index}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-sm ui-text-muted">{field.key || '(novo campo)'}</span>
              <div className="flex items-center gap-1">
                <IconButton label="Subir" onClick={() => move(index, -1)} disabled={index === 0}>
                  <ArrowUp size={16} />
                </IconButton>
                <IconButton label="Descer" onClick={() => move(index, 1)} disabled={index === fields.length - 1}>
                  <ArrowDown size={16} />
                </IconButton>
                <IconButton
                  label={field.lockedBecause || 'Remover este campo'}
                  onClick={() => remove(index)}
                  disabled={Boolean(field.lockedBecause)}
                >
                  <Trash2 size={16} />
                </IconButton>
              </div>
            </div>
            <div className="grid gap-4">
              {field.lockedBecause ? null : (
                <Field label="Identificador">
                  <input
                    className="ui-input font-mono"
                    value={field.key}
                    placeholder="por_exemplo_novo_campo"
                    onChange={(e) => change(index, { key: e.target.value })}
                  />
                </Field>
              )}
              <Field label="Nome visível">
                <input className="ui-input" value={field.label} onChange={(e) => change(index, { label: e.target.value })} />
              </Field>
              <Field label="O que o agente deve lá pôr">
                <textarea
                  className="ui-input min-h-20"
                  value={field.description}
                  onChange={(e) => change(index, { description: e.target.value })}
                />
              </Field>
            </div>
            {field.lockedBecause ? (
              <p className="mt-3 mb-0 text-sm ui-text-muted">Este campo não pode ser removido: {field.lockedBecause}</p>
            ) : null}
          </Card>
        ))}
      </div>

      <button type="button" className="ui-btn-secondary mt-4 text-sm" onClick={add}>
        Acrescentar campo
      </button>
    </TemplateEditorShell>
  );
}

function FieldsDraftPreview({ templateId, fields }: { templateId: string; fields: EditorField[] }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const key = JSON.stringify(fields);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/templates/${templateId}/fields/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields }),
    })
      .then(async (r) => ({ ok: r.ok, body: await r.text() }))
      .then(({ ok, body }) => {
        if (cancelled) return;
        if (!ok) {
          // A draft that breaks the citation spine is refused, and saying which rule it broke
          // is more use than an empty pane.
          let reason = 'Estes campos ainda não formam um template válido.';
          try {
            reason = (JSON.parse(body).error as string) || reason;
          } catch {}
          setError(reason);
          return;
        }
        setError('');
        setText(body);
      })
      .catch(() => !cancelled && setError('Não foi possível pré-visualizar estes campos.'));
    return () => {
      cancelled = true;
    };
    // `key` IS the serialised fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, key]);

  if (error) return <p className="ui-soft-panel m-0 rounded-lg p-4 text-base ui-text-muted">{error}</p>;
  if (!text) return <p className="m-0 text-base ui-text-muted">A carregar…</p>;
  return (
    <pre className="m-0 min-h-0 w-full flex-1 overflow-auto rounded-md border border-hair p-4 font-mono text-xs leading-relaxed">
      {text}
    </pre>
  );
}
