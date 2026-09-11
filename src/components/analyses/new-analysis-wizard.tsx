'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Link2 } from 'lucide-react';

import { ContextHelpLink } from '@/components/help/context-help-link';
import { DocumentPicker, type PickerDoc } from '@/components/library/document-picker';
import { PageHeader } from '@/components/ui/page';
import { isOfficialDocument } from '@/lib/library-layout';
import {
  ANALYSIS_TYPE_LABELS,
  relatedDocumentRelationLabel,
  type AnalysisType,
} from '@/lib/types';

type LibraryDoc = PickerDoc;
type Template = {
  templateId: string;
  name: string;
  analysisType: AnalysisType;
  version: number;
  active: boolean;
  source: 'builtin' | 'library';
  valid: boolean;
  validationError: string;
  kind: 'docx' | 'eml' | 'json';
};
type RelationRecommendation = {
  relationId: string;
  otherDocumentId: string;
  otherDocumentName: string;
  status: 'proposed' | 'confirmed' | 'rejected';
  confidence: { level: string; basis: string };
  motives: Array<{ type: string; evidence?: { ai?: { rationale?: string } } }>;
};

const STEPS = ['Resultado', 'Documento principal', 'Documentos de apoio', 'Confirmar'] as const;
const TYPE_CARDS: Array<{ type: AnalysisType; title: string; description: string; output: string }> = [
  {
    type: 'summary', title: 'Resumo documental', output: 'Uma nota informativa',
    description: 'Organiza obrigações, prazos, responsabilidades e referências, sempre com a respetiva fonte.',
  },
  {
    type: 'revision', title: 'Revisão / Atualização', output: 'Um relatório de revisão',
    description: 'Compara documentos, apresenta as diferenças e pede-lhe as decisões jurídicas necessárias.',
  },
];

export type TutorialWizardState = {
  analysisType: AnalysisType;
  docs: LibraryDoc[];
  templates?: Template[];
  recommendations?: RelationRecommendation[];
  target: string;
  onAction: (key: string, value: unknown) => void;
};

export function NewAnalysisWizard({ tutorial }: { tutorial?: TutorialWizardState }) {
  const router = useRouter();
  const tutorialStep = tutorial?.target === 'choose-main' ? 1 : tutorial?.target === 'confirm-support' ? 2 : tutorial?.target === 'start-analysis' ? 3 : 0;
  const [step, setStep] = useState(tutorialStep);
  const [docs, setDocs] = useState<LibraryDoc[]>(tutorial?.docs || []);
  const [templates, setTemplates] = useState<Template[]>(tutorial?.templates || []);
  const [recommendations, setRecommendations] = useState<RelationRecommendation[]>(tutorial?.recommendations || []);
  const [type, setType] = useState<AnalysisType | null>(tutorialStep > 0 ? tutorial?.analysisType || null : null);
  const [mainId, setMainId] = useState(tutorialStep > 1 ? tutorial?.docs[0]?.documentId || '' : '');
  const [relatedIds, setRelatedIds] = useState<string[]>(tutorialStep > 2 ? [tutorial?.recommendations?.[0]?.otherDocumentId || ''].filter(Boolean) : []);
  const [templateId, setTemplateId] = useState('');
  const [instructions, setInstructions] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  const loadDocs = useCallback(async () => {
    const lib = await fetch('/api/library/documents').then((response) => response.json());
    if (lib.ok) setDocs(lib.documents.filter((doc: LibraryDoc) => doc.state === 'indexed' && isOfficialDocument(doc.path)));
  }, []);

  useEffect(() => {
    if (tutorial) return;
    void loadDocs();
    void fetch('/api/templates').then((response) => response.json()).then((data) => {
      if (data.ok) setTemplates(data.templates.filter((template: Template) => template.active));
    });
  }, [loadDocs, tutorial]);

  useEffect(() => {
    if (!mainId) { setRecommendations(tutorial?.recommendations || []); return; }
    if (tutorial) return;
    void fetch(`/api/library/documents/${mainId}`).then((response) => response.json()).then((data) => {
      if (data.ok) setRecommendations((data.relations || []).filter((relation: RelationRecommendation) => relation.status === 'confirmed'));
    });
  }, [mainId, tutorial]);

  const mainDoc = docs.find((doc) => doc.documentId === mainId);
  const recommendedIds = new Set(recommendations.map((item) => item.otherDocumentId));
  const otherDocs = docs.filter((doc) => doc.documentId !== mainId && !recommendedIds.has(doc.documentId));
  const wordTemplates = useMemo(
    () => templates.filter((template) => template.kind === 'docx' && template.valid && (!type || template.analysisType === type)),
    [templates, type],
  );
  const selectedDocs = relatedIds.map((id) => docs.find((doc) => doc.documentId === id)).filter(Boolean) as LibraryDoc[];
  const canNext = step === 0 ? type !== null : step === 1 ? mainId !== '' : true;

  function toggleRelated(id: string) {
    setRelatedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  }

  async function start() {
    if (!type || !mainId) return;
    if (tutorial) { tutorial.onAction('analysisStarted', true); return; }
    setStarting(true);
    setError('');
    try {
      const created = await fetch('/api/analyses', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, mainDocumentId: mainId, relatedDocumentIds: relatedIds, templateId, instructions }),
      }).then((response) => response.json());
      if (!created.ok) throw new Error(created.error || 'Não foi possível criar a análise.');
      const id = created.analysis.analysisId as string;
      const kickoff = type === 'revision' && relatedIds.length === 0
        ? `/api/analyses/${id}/identify-relations`
        : `/api/analyses/${id}/run`;
      void fetch(kickoff, { method: 'POST' });
      router.push(`/analyses/${id}` as Route);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível iniciar a análise.');
      setStarting(false);
    }
  }

  return (
    <div className={`mx-auto flex min-h-0 w-full flex-1 flex-col overflow-hidden ${step === 1 || step === 2 ? 'max-w-[84rem]' : 'max-w-5xl'}`}>
      <PageHeader
        title="Nova análise"
        description="Quatro passos para escolher as fontes e confirmar o trabalho."
        actions={<div className="flex items-center gap-2"><ContextHelpLink context={step === 2 ? 'analysis.relations' : 'analysis.sources'} label="Ajuda desta página" /><Link href="/" className="ui-btn-secondary rounded-md px-3.5 py-1.5 text-base no-underline">Cancelar</Link></div>}
      />

      <ol className="ui-panel m-0 mb-6 flex list-none items-center justify-center gap-2 overflow-x-auto rounded-xl px-3 py-2">
        {STEPS.map((label, index) => (
          <li key={label} className="flex shrink-0 items-center gap-2">
            <button
              type="button" disabled={index > step && !canNext}
              onClick={() => index <= step && setStep(index)}
              className={`flex items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1 text-sm ${
                index === step ? 'bg-accent-soft font-medium text-accent-strong' : index < step ? 'text-ink1 hover:bg-surface-soft' : 'ui-text-subtle'
              }`}
            >
              <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-xs ${index < step ? 'bg-accent text-white' : 'border border-line1'}`}>
                {index < step ? <Check aria-hidden className="h-3 w-3" /> : index + 1}
              </span>
              {label}
            </button>
            {index < STEPS.length - 1 ? <span aria-hidden className="h-px w-8 bg-line1" /> : null}
          </li>
        ))}
      </ol>

      {error ? <p className="mb-4 text-base text-danger">{error}</p> : null}
      <div className="ui-panel flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl p-6">
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {step === 0 ? (
            <div className="grid gap-3">
              <h2 className="m-0 text-lg font-medium text-ink0">Que resultado pretende?</h2>
              {TYPE_CARDS.map((card) => (
                <button
                  key={card.type} type="button"
                  data-tutorial-target={`choose-${card.type}`}
                  onClick={() => { setType(card.type); setTemplateId(''); setStep(1); tutorial?.onAction('typeChosen', card.type); }}
                  className={`rounded-lg border p-5 text-left ${type === card.type ? 'border-accent bg-accent-ghost' : 'border-line0 hover:border-accent'}`}
                >
                  <span className="text-base font-semibold text-ink0">{card.title}</span>
                  <span className="ui-pill-info ml-2 rounded-md px-2 py-0.5 text-sm">{card.output}</span>
                  <p className="mt-1.5 mb-0 text-base ui-text-muted">{card.description}</p>
                </button>
              ))}
            </div>
          ) : null}

          {step === 1 ? (
            <div className="grid gap-3">
              <div><h2 className="m-0 text-lg font-medium text-ink0">Qual é o documento principal?</h2><p className="mt-1 mb-0 text-sm ui-text-muted">{type === 'summary' ? 'O documento que pretende resumir.' : 'O documento que pretende rever ou atualizar.'}</p></div>
              <DocumentPicker
                docs={docs} mode="single" selectedIds={mainId ? [mainId] : []}
                onToggle={(id) => { setMainId((current) => current === id ? '' : id); setRelatedIds((ids) => ids.filter((value) => value !== id)); if (tutorial) { setStep(2); tutorial.onAction('mainConfirmed', true); } }}
                onUploaded={loadDocs}
                rowTarget={(id) => id === tutorial?.docs[0]?.documentId ? 'choose-main' : undefined}
              />
            </div>
          ) : null}

          {step === 2 ? (
            <div className="grid gap-4">
              <div><h2 className="m-0 text-lg font-medium text-ink0">Que documentos podem ajudar?</h2><p className="mt-1 mb-0 text-sm ui-text-muted">Cada seleção é uma confirmação: a análise poderá citar esse documento.</p></div>

              {recommendations.length ? (
                <section>
                  <div className="mb-2 flex items-center gap-2"><Link2 aria-hidden className="h-4 w-4 text-accent-strong" /><h3 className="m-0 text-base font-medium text-ink0">Recomendados pelas relações que já confirmou</h3></div>
                  <div className="grid gap-2 md:grid-cols-2">
                    {recommendations.map((relation) => {
                      const selected = relatedIds.includes(relation.otherDocumentId);
                      const reason = relation.motives.map((motive) => relatedDocumentRelationLabel(motive.type)).filter(Boolean).join(', ');
                      return (
                        <button key={relation.otherDocumentId} type="button" data-tutorial-target="confirm-support" onClick={() => { toggleRelated(relation.otherDocumentId); if (tutorial) { setStep(3); tutorial.onAction('sourceConfirmed', true); } }} className={`rounded-lg border p-4 text-left ${selected ? 'border-accent bg-accent-ghost' : 'border-line0 hover:border-accent'}`}>
                          <span className="flex items-center justify-between gap-3"><strong className="text-ink0">{relation.otherDocumentName}</strong>{selected ? <span className="ui-pill-ok rounded-md px-2 py-0.5 text-xs">Selecionado</span> : null}</span>
                          <span className="mt-1 block text-sm ui-text-muted">Relação confirmada: {reason || 'documento relacionado'}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ) : (
                <div className="ui-soft-panel rounded-lg p-4 text-sm ui-text-muted">
                  Não existem relações confirmadas para recomendar. Pode escolher abaixo ou preparar primeiro as{' '}
                  <Link href={`/library/${mainId}?tab=relacoes` as Route} className="ui-link">relações deste documento</Link>.
                </div>
              )}

              <section>
                <h3 className="m-0 mb-2 text-base font-medium text-ink0">Outros documentos oficiais</h3>
                <DocumentPicker docs={otherDocs} mode="multi" selectedIds={relatedIds.filter((id) => !recommendedIds.has(id))} onToggle={toggleRelated} onUploaded={loadDocs} emptyHint="Não existem outros documentos oficiais prontos." />
              </section>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="grid gap-5" data-tutorial-target="review-setup">
              <div><h2 className="m-0 text-lg font-medium text-ink0">Confirme antes de começar</h2><p className="mt-1 mb-0 text-sm ui-text-muted">A aplicação só poderá citar os documentos indicados aqui.</p></div>
              <div className="grid gap-3 rounded-lg border border-line0 p-4">
                <p className="m-0"><span className="ui-text-muted">Resultado:</span> <strong className="text-ink0">{type ? ANALYSIS_TYPE_LABELS[type] : '—'}</strong></p>
                <p className="m-0"><span className="ui-text-muted">Documento principal:</span> <strong className="text-ink0">{mainDoc?.title || mainDoc?.name || '—'}</strong></p>
                <div><p className="m-0 ui-text-muted">Documentos de apoio:</p>{selectedDocs.length ? <ul className="mb-0 mt-1 pl-5">{selectedDocs.map((doc) => <li key={doc.documentId}>{doc.title || doc.name}</li>)}</ul> : <p className="mt-1 mb-0 text-ink1">Nenhum</p>}</div>
              </div>

              <details className="rounded-lg border border-line0 p-4">
                <summary className="cursor-pointer font-medium text-ink0">Opções avançadas</summary>
                <div className="mt-4 grid gap-4">
                  <label className="grid gap-1.5"><span className="text-sm font-medium text-ink0">Template Word</span><select value={templateId} onChange={(event) => setTemplateId(event.target.value)} className="ui-input rounded-md px-3 py-2"><option value="">Template standard do fluxo</option>{wordTemplates.map((template) => <option key={template.templateId} value={template.templateId}>{template.name} · v{template.version}</option>)}</select></label>
                  <label className="grid gap-1.5"><span className="text-sm font-medium text-ink0">Instruções adicionais</span><textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={4} placeholder="Ex.: Dê especial atenção aos prazos de reporte." className="ui-input rounded-md px-3 py-2" /></label>
                </div>
              </details>
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex shrink-0 items-center justify-between border-t border-line0 pt-4">
          <button type="button" disabled={step === 0} onClick={() => setStep((value) => Math.max(0, value - 1))} className="ui-btn-secondary rounded-md px-3.5 py-1.5 text-base disabled:opacity-40">← Anterior</button>
          {step < STEPS.length - 1 ? (
            <button type="button" data-tutorial-target={tutorial && step === 1 ? 'confirm-source' : undefined} disabled={!canNext} onClick={() => { setStep((value) => value + 1); if (tutorial && step === 1) tutorial.onAction('sourceConfirmed', true); }} className="ui-btn-primary rounded-md px-4 py-2 text-base disabled:opacity-40">Seguinte →</button>
          ) : (
            <button type="button" data-tutorial-target={tutorial ? 'start-analysis' : undefined} disabled={starting || !type || !mainId} onClick={start} className="ui-btn-primary rounded-md px-4 py-2 text-base disabled:opacity-40">{starting ? 'A iniciar…' : 'Iniciar análise'}</button>
          )}
        </div>
      </div>
    </div>
  );
}
