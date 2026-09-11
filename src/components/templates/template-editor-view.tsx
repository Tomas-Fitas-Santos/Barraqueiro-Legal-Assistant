'use client';

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { DocxPreview } from '@/components/library/docx-preview';
import { IconButton } from '@/components/templates/icon-button';
import { PreviewControls, usePreviewSubject, useRefreshMode } from '@/components/templates/preview-pane';
import { TemplateEditorShell } from '@/components/templates/template-editor-shell';
import { Card, EmptyState, Field } from '@/components/ui/page';

/**
 * Editing a Word template as what it is: a list of blocks.
 *
 * The alternative was editing Word XML, where the placeholders that make a template a
 * template are indistinguishable from the prose around them and a stray edit silently
 * breaks every document generated afterwards. Here a placeholder is a property of a block,
 * so reordering sections, adding one, or removing one cannot damage it by accident — and
 * removing one deliberately is named before it is allowed.
 */

type Paragraph = { type: 'paragraph'; text: string; style?: string };
type Loop = { type: 'loop'; name: string; blocks: Paragraph[] };
type Table = { type: 'table'; rowLoop: string; columns: Array<{ header: string; cell: string; width: number }> };
export type TemplateBlock = Paragraph | Loop | Table;
type Block = TemplateBlock;

const STYLE_LABELS: Record<string, string> = {
  Normal: 'Texto normal',
  Title: 'Título',
  Subtitle: 'Subtítulo',
  Heading1: 'Cabeçalho de secção',
  Small: 'Nota pequena',
};

const BLOCK_KIND_LABELS: Record<Block['type'], string> = {
  paragraph: 'Parágrafo',
  loop: 'Secções repetidas',
  table: 'Tabela',
};

export function TemplateEditorView({ templateId, tutorial }: { templateId: string; tutorial?: { name: string; blocks: TemplateBlock[]; preview: ReactNode; onSave: () => void } }) {
  const [name, setName] = useState(tutorial?.name || '');
  const [blocks, setBlocks] = useState<Block[] | null>(tutorial?.blocks || null);
  const [edited, setEdited] = useState(Boolean(tutorial));
  const [required, setRequired] = useState<string[]>([]);
  const [dirty, setDirty] = useState(Boolean(tutorial));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmMissing, setConfirmMissing] = useState<string[] | null>(null);
  // Bumped when the letterhead changes, which alters the rendered bytes without altering a
  // single block — so the preview would otherwise keep showing the old mark.
  const [logoStamp, setLogoStamp] = useState(0);
  const [refreshMode, setRefreshMode] = useRefreshMode();
  const { shown, stale, refresh } = usePreviewSubject(blocks ?? [], refreshMode);

  const load = useCallback(async () => {
    const res = await fetch(`/api/templates/${templateId}/blocks`);
    const data = await res.json();
    if (!data.ok) {
      setMessage(data.error || 'Não foi possível carregar o template.');
      return;
    }
    setName(data.name);
    setBlocks(data.blocks);
    setEdited(data.edited);
    setRequired(data.requiredFields);
    setDirty(false);
  }, [templateId]);

  useEffect(() => {
    if (!tutorial) void load();
  }, [load, tutorial]);

  const update = (next: Block[]) => {
    setBlocks(next);
    setDirty(true);
    setMessage('');
  };

  const save = async (confirm = false) => {
    if (!blocks) return;
    if (tutorial) { setEdited(true); setDirty(false); setMessage('Template guardado nesta aplicação de treino.'); tutorial.onSave(); return; }
    setSaving(true);
    setMessage('');
    const res = await fetch(`/api/templates/${templateId}/blocks`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blocks, confirm }),
    });
    const data = await res.json();
    setSaving(false);
    if (res.status === 409 && data.needsConfirmation) {
      setConfirmMissing(data.missing);
      return;
    }
    setConfirmMissing(null);
    if (!data.ok) {
      setMessage(data.error || 'Não foi possível guardar.');
      return;
    }
    setMessage('Template guardado e publicado na biblioteca.');
    await load();
  };

  const revert = async () => {
    setSaving(true);
    await fetch(`/api/templates/${templateId}/blocks`, { method: 'DELETE' });
    setSaving(false);
    setMessage('Template reposto na versão da aplicação.');
    await load();
  };

  const preview = tutorial?.preview || (
    <>
      <PreviewControls mode={refreshMode} onMode={setRefreshMode} stale={stale} onRefresh={refresh} />
      <DocxPreview
        className="min-h-0 flex-1"
        source={{ url: `/api/templates/${templateId}/preview`, post: { blocks: shown } }}
        cacheKey={String(logoStamp)}
      />
    </>
  );

  if (!blocks) return <EmptyState title="A carregar…" />;

  const move = (index: number, by: number) => {
    const next = [...blocks];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    update(next);
  };

  return (
    <TemplateEditorShell
      title={name || 'Template'}
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
      saveTarget={tutorial ? 'save-template' : undefined}
    >

      {!tutorial ? <LetterheadCard
        onChanged={() => {
          setMessage('Logótipo atualizado nos templates.');
          setLogoStamp((s) => s + 1);
        }}
      /> : null}


      {confirmMissing ? (
        <Card className="mb-6 border-warn">
          <h2 className="m-0 mb-2 text-lg font-semibold text-ink0">Confirmação necessária</h2>
          <p className="m-0 mb-3 text-base ui-text-muted">
            Esta versão deixa de usar {confirmMissing.map((f) => `{${f}}`).join(', ')}. Os documentos gerados a partir
            daqui deixam de incluir esse conteúdo.
          </p>
          <div className="flex gap-3">
            <button type="button" className="ui-btn-danger" onClick={() => void save(true)}>
              Guardar mesmo assim
            </button>
            <button type="button" className="ui-btn-secondary" onClick={() => setConfirmMissing(null)}>
              Cancelar
            </button>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-4">
        {blocks.map((block, index) => (
          <Card key={index}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <span className="text-sm font-medium ui-text-muted">{BLOCK_KIND_LABELS[block.type]}</span>
              <div className="flex items-center gap-1">
                <IconButton label="Subir" onClick={() => move(index, -1)} disabled={index === 0}>
                  <ArrowUp size={16} />
                </IconButton>
                <IconButton label="Descer" onClick={() => move(index, 1)} disabled={index === blocks.length - 1}>
                  <ArrowDown size={16} />
                </IconButton>
                <IconButton label="Remover" onClick={() => update(blocks.filter((_, i) => i !== index))}>
                  <Trash2 size={16} />
                </IconButton>
              </div>
            </div>
            <BlockEditor
              block={block}
              onChange={(next) => update(blocks.map((b, i) => (i === index ? next : b)))}
            />
          </Card>
        ))}
      </div>

      <div className="mt-4 flex gap-3">
        <button
          type="button"
          className="ui-btn-secondary"
          onClick={() => update([...blocks, { type: 'paragraph', text: '', style: 'Normal' }])}
        >
          <Plus size={16} /> Parágrafo
        </button>
        <button
          type="button"
          className="ui-btn-secondary"
          onClick={() =>
            update([
              ...blocks,
              { type: 'paragraph', text: 'Nova secção', style: 'Heading1' },
              { type: 'paragraph', text: '', style: 'Normal' },
            ])
          }
        >
          <Plus size={16} /> Secção
        </button>
      </div>

      <p className="mt-6 mb-0 text-sm ui-text-muted">
        Campos preenchidos automaticamente: {required.map((f) => `{${f}}`).join(', ')}. Um campo removido deixa de
        aparecer nos documentos gerados.
      </p>
    </TemplateEditorShell>
  );
}

function BlockEditor({ block, onChange }: { block: Block; onChange: (next: Block) => void }) {
  if (block.type === 'paragraph') {
    return (
      <div className="grid gap-3 sm:grid-cols-[1fr_14rem]">
        <Field label="Texto">
          <textarea
            className="ui-input min-h-20"
            value={block.text}
            onChange={(e) => onChange({ ...block, text: e.target.value })}
          />
        </Field>
        <Field label="Estilo">
          <select
            className="ui-input"
            value={block.style || 'Normal'}
            onChange={(e) => onChange({ ...block, style: e.target.value })}
          >
            {Object.entries(STYLE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
    );
  }

  if (block.type === 'loop') {
    return (
      <div className="grid gap-3">
        <p className="m-0 text-base ui-text-muted">
          Repetido para cada secção do documento gerado ({`{${block.name}}`}).
        </p>
        {block.blocks.map((inner, i) => (
          <div key={i} className="ui-soft-panel rounded-lg p-4">
            <BlockEditor
              block={inner}
              onChange={(next) =>
                onChange({ ...block, blocks: block.blocks.map((b, j) => (j === i ? (next as Paragraph) : b)) })
              }
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <p className="m-0 text-base ui-text-muted">
        Uma linha por cada {`{${block.rowLoop}}`}. O cabeçalho é fixo; a célula indica o campo que a preenche.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left ui-text-muted">
              <th className="py-1.5 pr-3 font-medium">Cabeçalho</th>
              <th className="py-1.5 pr-3 font-medium">Conteúdo</th>
              <th className="py-1.5 font-medium">Largura</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {block.columns.map((column, i) => (
              <tr key={i} className="border-t border-line0">
                <td className="py-1.5 pr-3">
                  <input
                    className="ui-input"
                    value={column.header}
                    onChange={(e) =>
                      onChange({
                        ...block,
                        columns: block.columns.map((c, j) => (j === i ? { ...c, header: e.target.value } : c)),
                      })
                    }
                  />
                </td>
                <td className="py-1.5 pr-3">
                  <input
                    className="ui-input font-mono text-xs"
                    value={column.cell}
                    onChange={(e) =>
                      onChange({
                        ...block,
                        columns: block.columns.map((c, j) => (j === i ? { ...c, cell: e.target.value } : c)),
                      })
                    }
                  />
                </td>
                <td className="py-1.5">
                  <input
                    type="number"
                    className="ui-input w-24"
                    value={column.width}
                    onChange={(e) =>
                      onChange({
                        ...block,
                        columns: block.columns.map((c, j) =>
                          j === i ? { ...c, width: Number(e.target.value) || 0 } : c,
                        ),
                      })
                    }
                  />
                </td>
                <td className="py-1.5 pl-2">
                  <IconButton
                    label="Remover coluna"
                    onClick={() => onChange({ ...block, columns: block.columns.filter((_, j) => j !== i) })}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <button
          type="button"
          className="ui-btn-secondary"
          onClick={() => onChange({ ...block, columns: [...block.columns, { header: 'Coluna', cell: '', width: 1000 }] })}
        >
          <Plus size={16} /> Coluna
        </button>
      </div>
    </div>
  );
}

type LogoInfo = {
  isDefault: boolean;
  px: { w: number; h: number };
  printedMm: { w: number; h: number };
  boxMm: { w: number; h: number };
  maxBytes: number;
};

function LetterheadCard({ onChanged }: { onChanged: () => void }) {
  const [logo, setLogo] = useState<LogoInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Bumped after every change so the browser refetches the image instead of showing the old one.
  const [stamp, setStamp] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const data = await fetch('/api/templates/logo').then((r) => r.json());
    if (data.ok) setLogo(data.logo);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (file: File) => {
    setBusy(true);
    setError('');
    const res = await fetch('/api/templates/logo', { method: 'POST', body: await file.arrayBuffer() });
    const data = await res.json();
    setBusy(false);
    if (!data.ok) {
      setError(data.error || 'Não foi possível usar esta imagem.');
      return;
    }
    setLogo(data.logo);
    setStamp((s) => s + 1);
    onChanged();
  };

  const reset = async () => {
    setBusy(true);
    const data = await fetch('/api/templates/logo', { method: 'DELETE' }).then((r) => r.json());
    setBusy(false);
    if (data.ok) setLogo(data.logo);
    setStamp((s) => s + 1);
    onChanged();
  };

  if (!logo) return null;

  return (
    <Card className="mb-6">
      <h2 className="m-0 mb-1 text-lg font-semibold text-ink0">Logótipo</h2>
      <p className="m-0 mb-4 text-base ui-text-muted">
        Aparece no cabeçalho de todos os documentos gerados. Uma imagem nova é ajustada ao mesmo espaço, mantendo as
        proporções — nunca é esticada.
      </p>
      <div className="flex flex-wrap items-center gap-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/templates/logo/image?v=${stamp}`}
          alt="Logótipo atual"
          className="ui-soft-panel max-h-24 rounded-lg p-3"
        />
        <div className="grid gap-1 text-base">
          <span className="ui-text-muted">
            Imagem: {logo.px.w}×{logo.px.h} px {logo.isDefault ? '(a do Grupo Barraqueiro)' : '(sua)'}
          </span>
          <span className="ui-text-muted">
            Impresso a {logo.printedMm.w} × {logo.printedMm.h} mm, dentro de {logo.boxMm.w} × {logo.boxMm.h} mm
          </span>
        </div>
        <div className="flex flex-wrap gap-3">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = '';
            }}
          />
          <button type="button" className="ui-btn-secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
            Substituir
          </button>
          {logo.isDefault ? null : (
            <button type="button" className="ui-btn-secondary" disabled={busy} onClick={() => void reset()}>
              Repor
            </button>
          )}
        </div>
      </div>
      {error ? <p className="mt-3 mb-0 text-base text-danger">{error}</p> : null}
    </Card>
  );
}
