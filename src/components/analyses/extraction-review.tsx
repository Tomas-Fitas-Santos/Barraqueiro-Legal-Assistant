'use client';

import { useCallback, useEffect, useState } from 'react';

import { confidenceOf, ExtractionItemCard } from '@/components/analyses/extraction-item-card';
import { EmptyState } from '@/components/ui/page';
import { MATRIX_FIELDS, STATEMENT_FIELDS } from '@/lib/extraction-fields';
import type { WorkflowAction } from '@/lib/workflow';

// The extraction, as a document rather than as JSON.
//
// What the user approves is the WHOLE output — the briefing's §10 structure — so this is
// the surface that has to make it readable: every field named in the client's own words,
// every citation a link that opens the source at the cited page, the confidence on every
// segment, and the validator's rejections shown with their reason instead of hidden.
// Editing any field and saving produces a NEW extraction; the one being read stays intact.

export type ExtractionMeta = {
  extractionId: string;
  pathLetter: string;
  label: string;
  origin: 'agent' | 'manual';
  acceptedCount: number;
  rejectedCount: number;
  approvedAt: number | null;
  approvedBy: string;
  rejectedAt: number | null;
  rejectedBy: string;
  rejectionReason: string;
  note: string;
  createdAt: number;
  /** The fields this extraction was made with — not whatever the template says today. */
  fields: Array<{ key: string; label: string }>;
};

export type ExtractionItem = {
  itemId: string;
  seq: number;
  kind: 'statement' | 'matrix_line';
  payload: Record<string, unknown>;
  accepted: boolean;
  rejectionReason: string;
  decision: 'pending' | 'accepted' | 'rejected';
};

export type ExtractionReviewPayload = {
  ok: boolean;
  extraction: ExtractionMeta | null;
  items: ExtractionItem[];
  sources: Array<{ documentId: string; name: string; title: string }>;
};

/**
 * The fields to show, in order. They come from the EXTRACTION, so an item approved before the
 * template changed still reads with the fields it was made with. Rows written before the
 * template existed carry none, and fall back to the list the app shipped with.
 */
function fieldsOf(extraction: ExtractionMeta, kind: string): Array<[string, string]> {
  const spec = extraction.fields.length
    ? extraction.fields.map((f) => [f.key, f.label] as [string, string])
    : kind === 'matrix_row' || kind === 'matrix_line'
      ? MATRIX_FIELDS
      : STATEMENT_FIELDS;
  // `content` has its own place above the grid, so it must not also appear inside it.
  return spec.filter(([key]) => key !== 'content');
}

export function ExtractionReview({
  analysisId,
  path,
  canDecide,
  onOpenSource,
  onRefresh,
  approval = null,
  onApprove,
  onRejected,
  tutorial,
}: {
  analysisId: string;
  path: string;
  canDecide: boolean;
  onOpenSource: (documentId: string, page?: number, excerpt?: string) => void;
  onRefresh: () => Promise<void>;
  approval?: WorkflowAction | null;
  onApprove?: (action: WorkflowAction) => Promise<void>;
  onRejected?: () => void;
  tutorial?: { data: ExtractionReviewPayload; target: string; onAction: () => void };
}) {
  const [data, setData] = useState<ExtractionReviewPayload | null>(tutorial?.data || null);
  const [tab, setTab] = useState<'pendentes' | 'aceites' | 'excluidos'>(tutorial?.data.items.some((item) => item.accepted && item.payload.requires_legal_decision === true && item.decision === 'pending') ? 'pendentes' : 'aceites');
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  /** §13: what the app says this edit would do, waiting for an explicit confirmation. */
  const [confirmReasons, setConfirmReasons] = useState<string[] | null>(null);
  const [rejectingAll, setRejectingAll] = useState(false);
  const [rejectReason, setRejectReason] = useState(tutorial ? 'Rever o âmbito e validar novamente a fonte citada.' : '');

  const load = useCallback(async () => {
    const res = (await fetch(`/api/analyses/${analysisId}/extraction?path=${encodeURIComponent(path)}`).then((r) =>
      r.json(),
    )) as ExtractionReviewPayload;
    if (res.ok) {
      setData(res);
      const pendingCount = res.items.filter(
        (item) => item.accepted && item.payload.requires_legal_decision === true && item.decision === 'pending',
      ).length;
      const excludedCount = res.items.filter((item) => !item.accepted || item.decision === 'rejected').length;
      setTab(pendingCount ? 'pendentes' : excludedCount ? 'excluidos' : 'aceites');
    }
  }, [analysisId, path]);

  useEffect(() => {
    if (!tutorial) void load();
  }, [load, tutorial]);

  useEffect(() => {
    if (!tutorial) return;
    setData(tutorial.data);
    if (tutorial.target === 'accept-legal') setTab('pendentes');
  }, [tutorial]);

  if (!data) return <p className="m-0 text-base ui-text-muted">A carregar…</p>;
  if (!data.extraction) {
    return <EmptyState title="Sem extração" description="Ainda não foi produzida nenhuma extração nesta análise." />;
  }

  const { extraction, items, sources } = data;
  const sourceName = (id: string) => sources.find((s) => s.documentId === id)?.title || sources.find((s) => s.documentId === id)?.name || id;
  const pending = items.filter(
    (item) => item.accepted && item.payload.requires_legal_decision === true && item.decision === 'pending',
  );
  const accepted = items.filter(
    (item) => item.accepted && !(item.payload.requires_legal_decision === true && item.decision !== 'accepted'),
  );
  const excluded = items.filter((item) => !item.accepted || item.decision === 'rejected');
  const shown = tab === 'pendentes' ? pending : tab === 'aceites' ? accepted : excluded;
  const dirty = Object.keys(edits).length > 0;
  const decided = items.filter((item) => item.accepted && item.payload.requires_legal_decision === true && item.decision !== 'pending').length;
  const decisionTotal = decided + pending.length;


  async function save(confirmed = false) {
    setBusy('save');
    setError('');
    try {
      // Every item goes back, edited or not — the new extraction is a complete artifact,
      // not a patch, which is what makes the previous one safe to keep.
      const payload = items.map((item) => ({
        ...item.payload,
        ...(edits[item.itemId] || {}),
      }));
      const res = await fetch(`/api/analyses/${analysisId}/extraction`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: payload, path, confirmed }),
      }).then((r) => r.json());
      if (res.needsConfirmation) {
        setConfirmReasons(res.reasons || []);
        return;
      }
      if (!res.ok) {
        setError(res.error || 'Não foi possível guardar.');
        return;
      }
      setConfirmReasons(null);
      setEdits({});
      await load();
      await onRefresh();
    } finally {
      setBusy('');
    }
  }

  async function rejectAll() {
    const reason = rejectReason.trim();
    if (!reason) {
      setError('Explique o que deve ser corrigido na nova tentativa.');
      return;
    }
    if (tutorial) { setRejectingAll(false); tutorial.onAction(); onRejected?.(); return; }
    setBusy('reject-all');
    setError('');
    try {
      const res = await fetch(`/api/analyses/${analysisId}/extraction/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      }).then((response) => response.json());
      if (!res.ok) {
        setError(res.error || 'Não foi possível rejeitar estes resultados.');
        return;
      }
      setRejectingAll(false);
      onRejected?.();
      void fetch(`/api/analyses/${analysisId}/run`, { method: 'POST' });
    } finally {
      setBusy('');
    }
  }

  async function decide(itemId: string, decision: 'accepted' | 'rejected') {
    if (tutorial) {
      setData((current) => current ? { ...current, items: current.items.map((item) => item.itemId === itemId ? { ...item, decision } : item) } : current);
      tutorial.onAction();
      return;
    }
    await fetch(`/api/analyses/${analysisId}/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    await load();
    await onRefresh();
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="m-0 text-base font-medium text-ink0">
            Extração {extraction.label}
            {extraction.origin === 'manual' ? <span className="ui-text-muted"> · editada na aplicação</span> : null}
          </p>
          <p className="m-0 text-sm ui-text-muted">
            {extraction.acceptedCount} validado(s) · {extraction.rejectedCount} rejeitado(s) pelos validadores ·{' '}
            {new Date(extraction.createdAt).toLocaleString('pt-PT')}
            {extraction.approvedAt ? ` · aprovada em ${new Date(extraction.approvedAt).toLocaleString('pt-PT')}` : ''}
          </p>
        </div>
        <div className="flex gap-1">
          {(['pendentes', 'aceites', 'excluidos'] as const).map((key) => (
            <button
              key={key}
              type="button"
              data-tutorial-target={key === 'excluidos' ? 'show-excluded' : undefined}
              onClick={() => { setTab(key); if (tutorial?.target === 'show-excluded' && key === 'excluidos') tutorial.onAction(); }}
              className={`rounded-md px-2.5 py-1 text-sm ${
                tab === key ? 'bg-accent-soft font-medium text-accent-strong' : 'ui-btn-secondary'
              }`}
            >
              {key === 'pendentes'
                ? `Requerem decisão (${pending.length})`
                : key === 'aceites'
                  ? `Aceites (${accepted.length})`
                  : `Excluídos (${excluded.length})`}
            </button>
          ))}
        </div>
      </div>

      {decisionTotal > 0 ? (
        <div className="ui-panel-subtle rounded-lg p-3">
          <div className="mb-1 flex justify-between gap-3 text-sm">
            <span>{decided} de {decisionTotal} decisões jurídicas concluídas</span>
            <span className="ui-text-muted">{pending.length ? `${pending.length} por decidir` : 'Revisão concluída'}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-line0" role="progressbar" aria-valuenow={decided} aria-valuemin={0} aria-valuemax={decisionTotal}>
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${decisionTotal ? (decided / decisionTotal) * 100 : 0}%` }} />
          </div>
        </div>
      ) : null}

      {extraction.note ? <p className="m-0 text-sm ui-text-muted">{extraction.note}</p> : null}
      {error ? <p className="m-0 text-sm text-danger">{error}</p> : null}

      {dirty ? (
        <div className="ui-panel flex flex-wrap items-center justify-between gap-2 rounded-lg border border-accent p-3">
          <span className="text-sm">
            Alterou {Object.keys(edits).length} item(ns). Guardar cria uma extração nova — a atual mantém-se intacta.
          </span>
          <span className="flex gap-2">
            <button type="button" onClick={() => setEdits({})} className="ui-btn-secondary rounded-md px-3 py-1 text-sm">
              Descartar
            </button>
            <button
              type="button"
              disabled={busy !== ''}
              onClick={() => save()}
              className="ui-btn-primary rounded-md px-3 py-1 text-sm disabled:opacity-50"
            >
              {busy === 'save' ? 'A guardar…' : 'Guardar como nova extração'}
            </button>
          </span>
        </div>
      ) : null}

      {/* §13: the app names what the edit would remove or replace, and waits. */}
      {confirmReasons ? (
        <div className="ui-panel rounded-lg border border-warn p-3">
          <p className="m-0 mb-1.5 text-sm font-medium text-ink0">
            Esta alteração exige a sua confirmação explícita:
          </p>
          <ul className="m-0 mb-3 grid list-disc gap-1 pl-5 text-sm">
            {confirmReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy !== ''}
              onClick={() => save(true)}
              className="ui-btn-primary rounded-md px-3 py-1 text-sm disabled:opacity-50"
            >
              {busy === 'save' ? 'A guardar…' : 'Confirmo — guardar assim'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmReasons(null)}
              className="ui-btn-secondary rounded-md px-3 py-1 text-sm"
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : null}

      {shown.length === 0 ? (
        <p className="m-0 py-4 text-center text-sm ui-text-muted">
          {tab === 'pendentes' ? 'Não há decisões jurídicas pendentes.' : tab === 'aceites' ? 'Nenhum resultado aceite.' : 'Nenhum resultado excluído.'}
        </p>
      ) : null}

      {shown.map((item) => {
        const payload = item.payload as Record<string, string | number | boolean>;
        const legal = payload.requires_legal_decision === true;
        return (
          <ExtractionItemCard
            key={item.itemId}
            item={item}
            fields={fieldsOf(extraction, item.kind)}
            sourceName={sourceName}
            onOpenSource={(documentId, page, excerpt) => { onOpenSource(documentId, page, excerpt); if (tutorial?.target === 'open-citation') tutorial.onAction(); }}
            citationTarget={tutorial?.target === 'open-citation' ? 'open-citation' : undefined}
            borderClassName={
              item.accepted ? (legal && item.decision === 'pending' ? 'border-warn' : 'border-line0') : 'border-danger'
            }
            showField={(field) => edits[item.itemId]?.[field] !== undefined}
            renderValue={(field, value) => (
              // Every field here is content the model wrote, so every one is correctable.
              // The citation spine is not in this list at all.
              <EditableField
                value={edits[item.itemId]?.[field] ?? value}
                onChange={(v) => setEdits((e) => ({ ...e, [item.itemId]: { ...e[item.itemId], [field]: v } }))}
                className={field === 'content' ? 'text-base text-ink0' : undefined}
              />
            )}
            footer={
              // The one place a single item is still decided on its own: the briefing wants
              // every legally-loaded line judged explicitly, not covered by a bulk approval.
              item.accepted && legal ? (
                <div className="mt-2 flex items-center gap-2">
                  {item.decision === 'pending' ? (
                    canDecide ? (
                      <>
                        <span className="text-sm ui-text-muted">Decisão jurídica:</span>
                        <button
                          type="button"
                          data-tutorial-target="accept-legal"
                          onClick={() => decide(item.itemId, 'accepted')}
                          className="ui-btn-primary rounded-md px-3 py-1 text-sm"
                        >
                          Aceitar
                        </button>
                        <button
                          type="button"
                          onClick={() => decide(item.itemId, 'rejected')}
                          className="ui-btn-secondary rounded-md px-3 py-1 text-sm"
                        >
                          Rejeitar
                        </button>
                      </>
                    ) : (
                      <span className="text-sm ui-text-muted">Decisão jurídica pendente.</span>
                    )
                  ) : (
                    <>
                      <span
                        className={`${item.decision === 'accepted' ? 'ui-pill-ok' : 'ui-pill-warn'} rounded-md px-2 py-0.5 text-sm`}
                      >
                        {item.decision === 'accepted' ? 'Aceite' : 'Excluída do documento'}
                      </span>
                      {canDecide ? (
                        <button
                          type="button"
                          onClick={() => decide(item.itemId, item.decision === 'accepted' ? 'rejected' : 'accepted')}
                          className="ui-link text-sm"
                        >
                          {item.decision === 'accepted' ? 'Alterar para excluir' : 'Alterar para aceitar'}
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null
            }
          />
        );
      })}

      {approval && onApprove ? (
        <div className="sticky bottom-0 z-10 mt-2 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line0 bg-surface0/95 p-4 shadow-lg backdrop-blur">
          <div>
            <p className="m-0 text-sm font-medium text-ink0">Decisão sobre o conjunto</p>
            <p className="mt-0.5 mb-0 text-sm ui-text-muted">
              {approval.enabled ? 'A aplicação fixa estes resultados e prepara o documento para revisão.' : approval.disabledReason}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" data-tutorial-target="reject-extraction" onClick={() => { setRejectingAll(true); if (tutorial?.target === 'reject-extraction') tutorial.onAction(); }} className="ui-btn-secondary rounded-md px-3 py-1.5 text-sm">
              Rejeitar e tentar novamente
            </button>
            <button
              type="button"
              disabled={!approval.enabled || busy !== ''}
              title={!approval.enabled ? approval.disabledReason : 'Fixa estes resultados e prepara o documento.'}
              data-tutorial-target="approve-findings"
              onClick={() => onApprove(approval)}
              className="ui-btn-primary rounded-md px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {approval.label}
            </button>
          </div>
        </div>
      ) : null}

      {rejectingAll ? (
        <div className={tutorial ? 'mt-2' : 'fixed inset-0 z-[80] grid place-items-center bg-black/45 p-4'} role="dialog" aria-modal={tutorial ? undefined : 'true'} aria-labelledby="reject-extraction-title">
          <div className={`ui-panel w-full rounded-xl p-5 ${tutorial ? '' : 'max-w-xl shadow-2xl'}`}>
            <h3 id="reject-extraction-title" className="m-0 text-xl font-semibold text-ink0">Rejeitar estes resultados?</h3>
            <p className="mt-2 mb-3 text-sm ui-text-muted">
              A aplicação guarda esta tentativa no histórico, cria uma nova e volta a analisar as mesmas fontes. As decisões desta tentativa não passam para a seguinte.
            </p>
            <label className="grid gap-1 text-sm font-medium text-ink0">
              O que deve ser corrigido na nova tentativa?
              <textarea value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} rows={4} className="ui-input rounded-md p-2 font-normal" autoFocus />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setRejectingAll(false)} className="ui-btn-secondary rounded-md px-3 py-1.5 text-sm">Cancelar</button>
              <button type="button" data-tutorial-target="confirm-retry" disabled={busy !== '' || !rejectReason.trim()} onClick={rejectAll} className="ui-btn-primary rounded-md px-3 py-1.5 text-sm disabled:opacity-50">
                {busy === 'reject-all' ? 'A preparar nova tentativa…' : 'Rejeitar e criar nova tentativa'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A field that reads as text until you click it, then edits in place. */
function EditableField({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <span
        role="button"
        tabIndex={0}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') setEditing(true);
        }}
        title="Clique para editar"
        className={`cursor-text whitespace-pre-wrap rounded px-0.5 hover:bg-accent-soft ${className || ''}`}
      >
        {value || <span className="ui-text-subtle">(vazio)</span>}
      </span>
    );
  }
  return (
    <textarea
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => setEditing(false)}
      rows={Math.min(8, Math.max(1, Math.ceil(value.length / 80)))}
      className={`ui-input w-full rounded-md px-2 py-1 ${className || ''}`}
    />
  );
}

export { confidenceOf };
