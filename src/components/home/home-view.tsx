'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { EmptyState, PageHeader } from '@/components/ui/page';
import {
  ANALYSIS_STATE_LABELS,
  ANALYSIS_TYPE_LABELS,
  type AnalysisState,
  type AnalysisType,
} from '@/lib/types';
import type { NextTask } from '@/lib/workflow';

export type AnalysisRow = {
  analysisId: string;
  type: AnalysisType;
  mainDocumentName: string;
  state: AnalysisState;
  stateDetail: string;
  potentiallyAffected: boolean;
  itemCount: number;
  archived: boolean;
  updatedAt: number;
  nextTask: NextTask;
};

const STATE_PILLS: Partial<Record<AnalysisState, string>> = {
  aprovada: 'ui-pill-ok',
  erro: 'ui-pill-error',
  pronta_para_revisao: 'ui-pill-accent',
};

export function HomeView({ tutorial }: { tutorial?: { analyses: AnalysisRow[]; target?: string; onNewAnalysis: () => void } }) {
  const [analyses, setAnalyses] = useState<AnalysisRow[] | null>(tutorial?.analyses || null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const list = await fetch('/api/analyses').then((response) => response.json());
      if (!list.ok) throw new Error(list.error || 'Não foi possível carregar as análises.');
      setAnalyses(list.analyses);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível carregar as análises.');
    }
  }, []);

  useEffect(() => { if (!tutorial) void refresh(); }, [refresh, tutorial]);

  const archivedCount = (analyses || []).filter((row) => row.archived).length;
  const visible = (analyses || []).filter((row) => showArchived || !row.archived);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Processos"
        description="Todas as análises e o seu rasto completo — versões, confirmações, decisões."
        actions={tutorial ? (
          <button type="button" data-tutorial-target={tutorial.target} onClick={tutorial.onNewAnalysis} className="ui-btn-primary rounded-md px-4 py-2 text-base">Nova análise</button>
        ) : (
          <Link href={'/analyses/new' as Route} className="ui-btn-primary rounded-md px-4 py-2 text-base no-underline">Nova análise</Link>
        )}
      />
      {error ? <p className="mb-4 text-base text-danger">{error}</p> : null}
      {archivedCount > 0 ? (
        <p className="mb-3 mt-0 text-base ui-text-muted">
          {archivedCount} análise{archivedCount === 1 ? '' : 's'} arquivada{archivedCount === 1 ? '' : 's'} porque os documentos em que assenta{archivedCount === 1 ? '' : 'm'} já não estão na Biblioteca.{' '}
          <button type="button" onClick={() => setShowArchived((value) => !value)} className="ui-link text-base">
            {showArchived ? 'Ocultar arquivadas' : 'Mostrar arquivadas'}
          </button>
        </p>
      ) : null}

      {!analyses ? null : visible.length === 0 ? (
        <EmptyState title="Ainda sem análises" description="As análises iniciadas aparecem aqui com o seu estado, versões e histórico." />
      ) : (
        <div className="ui-panel max-h-full overflow-y-auto rounded-xl">
          <table className="w-full table-fixed border-collapse text-base">
            <thead className="sticky top-0 z-10 bg-surface">
              <tr className="text-left ui-text-muted">
                <th className="w-32 px-4 py-2.5 font-medium sm:w-44 lg:w-52">Tipo</th>
                <th className="px-4 py-2.5 font-medium">Documento principal</th>
                <th className="hidden w-64 px-4 py-2.5 font-medium md:table-cell">Estado</th>
                <th className="hidden w-20 px-4 py-2.5 text-right font-medium lg:table-cell">Itens</th>
                <th className="hidden w-44 px-4 py-2.5 font-medium xl:table-cell">Última atividade</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.analysisId} className="h-[64px] border-t border-line0 hover:bg-surface-soft">
                  <td className="truncate px-4 py-2.5">
                    <Link href={`/analyses/${row.analysisId}` as Route} className="ui-link font-medium no-underline">{ANALYSIS_TYPE_LABELS[row.type]}</Link>
                  </td>
                  <td className="truncate px-4 py-2.5" title={row.mainDocumentName}>{row.mainDocumentName}</td>
                  <td className="hidden px-4 py-2.5 md:table-cell">
                    <span className="flex flex-wrap gap-1.5">
                      <span className={`${STATE_PILLS[row.state] || 'ui-pill-info'} whitespace-nowrap rounded-md px-2 py-0.5 text-sm`} title={row.stateDetail || undefined}>{ANALYSIS_STATE_LABELS[row.state]}</span>
                      {row.potentiallyAffected ? <span className="ui-pill-warn whitespace-nowrap rounded-md px-2 py-0.5 text-sm">Potencialmente afetada</span> : null}
                      {row.archived ? <span className="ui-pill-warn whitespace-nowrap rounded-md px-2 py-0.5 text-sm">Arquivada</span> : null}
                    </span>
                  </td>
                  <td className="hidden px-4 py-2.5 text-right lg:table-cell">{row.itemCount || '—'}</td>
                  <td className="hidden whitespace-nowrap px-4 py-2.5 ui-text-muted xl:table-cell">{new Date(row.updatedAt).toLocaleString('pt-PT')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
