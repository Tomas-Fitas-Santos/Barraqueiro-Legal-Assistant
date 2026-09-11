'use client';

import type { Route } from 'next';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { PageHeader } from '@/components/ui/page';
import type { TutorialDefinition, TutorialKind } from '@/lib/tutorials';

type CatalogItem = TutorialDefinition & {
  fixture: { fixtureId: string; sourceName: string } | null;
  latestRun: { runId: string; currentStep: number; completedAt: number | null } | null;
};

export function TutorialsCatalog() {
  const router = useRouter();
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void fetch('/api/tutorials').then((response) => response.json()).then((payload) => {
      if (payload.ok) setItems(payload.tutorials);
      else setError(payload.error || 'Não foi possível carregar os tutoriais.');
    });
  }, []);

  async function start(kind: TutorialKind) {
    setBusy(kind);
    setError('');
    try {
      const payload = await fetch('/api/tutorials/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      }).then((response) => response.json());
      if (!payload.ok) {
        setError(payload.error || 'Não foi possível iniciar o tutorial.');
        return;
      }
      router.push(`/tutoriais/${kind}?run=${encodeURIComponent(payload.run.runId)}` as Route);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Tutoriais"
        description="Aprenda dentro de uma aplicação de treino igual ao percurso real, com orientação passo a passo."
      />
      <div className="mb-5 grid gap-3 rounded-xl border border-accent bg-accent-ghost p-4 md:grid-cols-[auto_1fr] md:items-center">
        <span className="grid h-11 w-11 place-items-center rounded-full bg-accent text-lg font-semibold text-white">?</span>
        <div><strong>Vai aprender fazendo</strong><p className="mt-1 mb-0 text-sm ui-text-muted">Os pop-ups indicam onde clicar, explicam cada decisão e acompanham-no desde o Início até ao resultado final.</p></div>
      </div>
      {error ? <p className="mb-4 text-sm text-danger">{error}</p> : null}
      {!items ? <p className="ui-text-muted">A carregar…</p> : (
        <div className="grid gap-4 lg:grid-cols-3">
          {items.map((item, index) => {
            const complete = Boolean(item.latestRun?.completedAt);
            const resumable = item.latestRun && !complete;
            return (
              <article key={item.kind} className="ui-panel flex min-h-[27rem] flex-col overflow-hidden rounded-xl">
                <div className="border-b border-line0 bg-surface-soft p-5">
                  <div className="flex items-start justify-between gap-3"><span className="grid h-9 w-9 place-items-center rounded-full bg-accent-strong font-semibold text-white">{index + 1}</span><span className="ui-pill-info rounded-full px-2 py-0.5 text-xs">Cerca de {item.minutes} min</span></div>
                  <h2 className="mt-4 mb-1 text-xl font-semibold text-ink0">{item.title}</h2>
                  <p className="m-0 text-sm text-ink1">{item.description}</p>
                </div>
                <div className="flex flex-1 flex-col p-5">
                  <p className="m-0 text-xs font-semibold uppercase tracking-wide ui-text-muted">Percurso</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">{item.journey.map((stage, stageIndex) => <span key={stage} className="contents"><span className="rounded bg-surface-soft px-2 py-1">{stage}</span>{stageIndex < item.journey.length - 1 ? <span className="ui-text-muted">›</span> : null}</span>)}</div>
                  <div className="my-4 flex-1 rounded-lg bg-accent-ghost p-3 text-sm"><strong>No fim:</strong> {item.outcome}</div>
                  <p className="mt-0 mb-3 break-words text-xs ui-text-muted">{item.fixture ? `Documento de treino: ${item.fixture.sourceName}` : 'Documento de treino ainda não preparado.'}</p>
                  {complete ? <p className="ui-pill-ok mb-3 mt-0 w-fit rounded-full px-2 py-0.5 text-xs">Concluído · pode repetir</p> : null}
                  <div className="flex flex-wrap gap-2">
                    {resumable ? <button type="button" onClick={() => router.push(`/tutoriais/${item.kind}?run=${item.latestRun?.runId}` as Route)} className="ui-btn-primary rounded-md px-3 py-1.5 text-sm">Continuar do passo {item.latestRun!.currentStep + 1}</button> : null}
                    <button type="button" disabled={!item.fixture || busy !== ''} onClick={() => start(item.kind)} className={`${resumable ? 'ui-btn-secondary' : 'ui-btn-primary'} rounded-md px-3 py-1.5 text-sm disabled:opacity-50`}>{busy === item.kind ? 'A preparar…' : complete || resumable ? 'Começar de novo' : item.fixture ? 'Começar percurso' : 'Em preparação'}</button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <div className="ui-soft-panel mt-5 rounded-lg p-4 text-sm ui-text-muted">Ambiente seguro: os tutoriais usam cópias privadas e imutáveis. Não criam análises, relações, versões, mensagens ou ficheiros no OneDrive e não usam IA.</div>
    </div>
  );
}
