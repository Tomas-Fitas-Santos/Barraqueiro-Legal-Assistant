'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, BookOpen, Check, ChevronRight, FileText, Mail, X } from 'lucide-react';

import { AnalysisTabs, DetalhesTab, EmailEditor, FeedBubble, HistoricoTab, PhaseStepper, type Analysis, type AnalysisDocument, type Conversion, type FeedEntry, type Item, type Panel, type PathInfo, type StageDef } from '@/components/analyses/analysis-chat-view';
import { ExtractionReview } from '@/components/analyses/extraction-review';
import { NewAnalysisWizard } from '@/components/analyses/new-analysis-wizard';
import { ContextHelpLink } from '@/components/help/context-help-link';
import { OutputSequence } from '@/components/analyses/output-sequence';
import { TutorialNetworkGuard } from '@/components/tutorials/tutorial-network-guard';
import { TemplateEditorView } from '@/components/templates/template-editor-view';
import { TopNavView } from '@/components/app/top-nav';
import { HomeView, type AnalysisRow } from '@/components/home/home-view';
import { DocumentDetailView, type DocumentPayload } from '@/components/library/document-detail-view';
import { DocumentList, type FileRow, type ListRow } from '@/components/library/document-list';
import { PageHeader } from '@/components/ui/page';
import { SlideOver } from '@/components/ui/slide-over';
import { tutorialStepMode, type TutorialDefinition, type TutorialKind, type TutorialStep } from '@/lib/tutorials';
import type { WorkflowStatus } from '@/lib/workflow';

type Run = {
  runId: string;
  kind: TutorialKind;
  currentStep: number;
  demoState: Record<string, unknown>;
  scenarioVersion: number;
  completedAt: number | null;
};
type Fixture = { fixtureId: string; sourceName: string; sourceMime: string; sourceSha256?: string; metadata: Record<string, unknown> };
type Payload = { ok: boolean; run: Run; tutorial: TutorialDefinition; fixture: Fixture; error?: string };

export function TutorialWorkspace({ kind, initialRunId }: { kind: TutorialKind; initialRunId: string }) {
  const router = useRouter();
  const [payload, setPayload] = useState<Payload | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async (runId: string) => {
    const result = await fetch(`/api/tutorials/runs/${encodeURIComponent(runId)}`).then((response) => response.json()) as Payload;
    if (result.ok) setPayload(result);
    else setError(result.error || 'Não foi possível abrir o tutorial.');
  }, []);

  useEffect(() => {
    if (initialRunId) { void load(initialRunId); return; }
    void fetch('/api/tutorials/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }),
    }).then((response) => response.json()).then((result) => {
      if (!result.ok) setError(result.error || 'Não foi possível iniciar o tutorial.');
      else router.replace(`/tutoriais/${kind}?run=${encodeURIComponent(result.run.runId)}` as Route);
    });
  }, [initialRunId, kind, load, router]);

  async function patch(input: { action: string; key?: string; value?: unknown }) {
    if (!payload) return null;
    setBusy(input.action);
    setError('');
    try {
      const result = await fetch(`/api/tutorials/runs/${payload.run.runId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      }).then((response) => response.json());
      if (!result.ok) { setError(result.error || 'Não foi possível guardar o passo.'); return null; }
      setPayload({ ...payload, run: result.run });
      return result.run as Run;
    } finally { setBusy(''); }
  }

  if (error && !payload) return <div className="ui-panel rounded-xl p-6"><p className="text-danger">{error}</p><Link href={'/tutoriais' as Route} className="ui-link">← Voltar aos tutoriais</Link></div>;
  if (!payload) return <p className="ui-text-muted">A preparar a aplicação de treino…</p>;

  const { run, tutorial, fixture } = payload;
  const step = tutorial.steps[run.currentStep];
  const last = tutorial.steps.length - 1;
  const progress = ((run.currentStep + 1) / tutorial.steps.length) * 100;
  const stage = tutorialStage(kind, run.currentStep);

  async function continueStep() {
    if (run.currentStep === last) await patch({ action: 'complete' });
    else await patch({ action: 'next' });
  }

  async function useHighlightedControl() {
    if (!step.interaction || busy) return;
    await patch({ action: 'demo-next', key: step.interaction.key, value: step.interaction.value });
  }

  async function finishTutorial() {
    const finished = await patch({ action: 'complete' });
    if (finished) router.push('/tutoriais' as Route);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="ui-panel mb-3 shrink-0 rounded-xl px-3 py-2.5" data-tutorial-controller>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="ui-pill-info rounded-full px-2.5 py-1 text-xs font-medium">Modo de treino</span>
            <div className="min-w-0">
              <h1 className="m-0 truncate text-base font-semibold">{tutorial.title} · {stage.title}</h1>
              <p className="m-0 text-xs ui-text-muted">Etapa {stage.index + 1} de {stage.total} · os dados reais não são alterados</p>
            </div>
            <div className="hidden items-center gap-1 sm:flex" aria-label={`Etapa ${stage.index + 1} de ${stage.total}`}>
              {Array.from({ length: stage.total }, (_, index) => <span key={index} className={`h-1.5 w-5 rounded-full ${index <= stage.index ? 'bg-accent' : 'bg-line0'}`} />)}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <button type="button" disabled={run.currentStep === 0 || busy !== ''} onClick={() => patch({ action: 'back' })} className="ui-btn-secondary rounded-md px-2.5 py-1.5 text-sm disabled:opacity-40"><ArrowLeft size={15} /> Voltar</button>
            <button type="button" disabled={busy !== '' || Boolean(run.completedAt)} onClick={() => patch({ action: 'skip' })} className="ui-link px-2 text-sm disabled:opacity-40">Saltar</button>
            <button type="button" onClick={() => patch({ action: 'restart' })} className="ui-btn-secondary rounded-md px-2.5 py-1.5 text-sm">Reiniciar</button>
            <Link href={'/tutoriais' as Route} className="ui-btn-secondary rounded-md px-2.5 py-1.5 text-sm no-underline"><X size={15} /> Terminar treino</Link>
          </div>
        </div>
        <div className="mt-2 h-1 shrink-0 overflow-hidden rounded-full bg-line0" role="progressbar" aria-valuenow={run.currentStep + 1} aria-valuemin={1} aria-valuemax={tutorial.steps.length} aria-label={`Progresso do treino`}>
          <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${progress}%` }} />
        </div>
      </header>
      {error ? <p className="mb-2 shrink-0 text-sm text-danger">{error}</p> : null}

      <TutorialNetworkGuard>
      <TutorialAppCanvas
        step={step}
        kind={kind}
        run={run}
        fixture={fixture}
        documentUrl={`/api/tutorials/runs/${run.runId}/document`}
        busy={busy !== ''}
        completed={Boolean(run.completedAt)}
        onTarget={useHighlightedControl}
        onContinue={continueStep}
        onRestart={() => patch({ action: 'restart' })}
        onFinish={finishTutorial}
      />
      </TutorialNetworkGuard>
    </div>
  );
}

const TUTORIAL_STAGES: Record<TutorialKind, Array<{ title: string; through: number }>> = {
  library: [
    { title: 'Orientação', through: 1 }, { title: 'Documento oficial', through: 11 },
    { title: 'Templates', through: 16 }, { title: 'Resultados', through: 19 }, { title: 'Conclusão', through: 20 },
  ],
  summary: [
    { title: 'Configuração', through: 4 }, { title: 'Rever resultados', through: 9 },
    { title: 'Histórico e nova tentativa', through: 21 }, { title: 'Documento final', through: 27 },
    { title: 'Entrega', through: 32 }, { title: 'Conclusão', through: 33 },
  ],
  revision: [
    { title: 'Configuração', through: 4 }, { title: 'Comparação', through: 8 },
    { title: 'Histórico e nova tentativa', through: 20 }, { title: 'Nova decisão', through: 22 },
    { title: 'Documento e entrega', through: 32 }, { title: 'Conclusão', through: 33 },
  ],
};

function tutorialStage(kind: TutorialKind, step: number) {
  const stages = TUTORIAL_STAGES[kind];
  const index = Math.max(0, stages.findIndex((stage) => step <= stage.through));
  return { title: stages[index].title, index, total: stages.length };
}

type FocusFrame = { left: number; top: number; width: number; height: number; canvasWidth: number; canvasHeight: number };

function TutorialCoachMark({ step, frame, busy, onContinue }: { step: TutorialStep; frame: FocusFrame; busy: boolean; onContinue: () => void }) {
  const mode = tutorialStepMode(step);
  const width = Math.min(340, frame.canvasWidth - 24);
  const estimatedHeight = mode === 'observe' ? 210 : 160;
  const rightRoom = frame.canvasWidth - frame.left - frame.width;
  const leftRoom = frame.left;
  const belowRoom = frame.canvasHeight - frame.top - frame.height;
  const placement = rightRoom >= width + 18 ? 'right' : leftRoom >= width + 18 ? 'left' : belowRoom >= estimatedHeight + 18 ? 'below' : 'above';
  const left = placement === 'right' ? frame.left + frame.width + 14
    : placement === 'left' ? frame.left - width - 14
      : Math.max(12, Math.min(frame.canvasWidth - width - 12, frame.left + (frame.width / 2) - (width / 2)));
  const top = placement === 'below' ? frame.top + frame.height + 14
    : placement === 'above' ? Math.max(12, frame.top - estimatedHeight - 14)
      : Math.max(12, Math.min(frame.canvasHeight - estimatedHeight - 12, frame.top + (frame.height / 2) - (estimatedHeight / 2)));
  const verticalPointer = Math.max(18, Math.min(estimatedHeight - 24, frame.top + (frame.height / 2) - top));
  const horizontalPointer = Math.max(18, Math.min(width - 24, frame.left + (frame.width / 2) - left));
  const pointerClass = placement === 'right' ? '-left-1.5 border-b-2 border-l-2' : placement === 'left' ? '-right-1.5 border-r-2 border-t-2' : placement === 'below' ? '-top-1.5 border-l-2 border-t-2' : '-bottom-1.5 border-b-2 border-r-2';
  return <section data-tutorial-coach role="region" aria-live="polite" aria-label={`Orientação: ${step.title}`} className="ui-panel absolute z-[60] rounded-xl border-2 border-accent bg-surface px-4 py-3 shadow-xl" style={{ top, left, width }}>
    <span aria-hidden className={`absolute h-3 w-3 rotate-45 border-accent bg-surface ${pointerClass}`} style={placement === 'right' || placement === 'left' ? { top: verticalPointer } : { left: horizontalPointer }} />
    <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-accent-strong"><BookOpen size={14} /> {mode === 'observe' ? 'Observe' : mode === 'input' ? 'Preencha' : 'Faça agora'}</div>
    <h2 className="m-0 text-base font-semibold">{step.title}</h2>
    <p className="mb-0 mt-1 text-sm leading-snug text-ink1">{step.instruction}</p>
    {mode === 'observe' ? <button type="button" disabled={busy} onClick={onContinue} className="ui-btn-primary mt-3 w-full justify-center rounded-md px-3 py-2 text-sm">{step.continueLabel || 'Compreendi'} <ChevronRight size={16} /></button> : null}
  </section>;
}

function TutorialAppCanvas(props: {
  step: TutorialStep; kind: TutorialKind; run: Run; fixture: Fixture; documentUrl: string;
  busy: boolean; completed: boolean;
  onTarget: () => void; onContinue: () => void; onRestart: () => void; onFinish: () => void;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [focusFrame, setFocusFrame] = useState<FocusFrame | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let current: HTMLElement | null = null;
    let frame = 0;
    let ready = props.step.target !== 'preview-panel';
    let settleTimer = 0;
    setFocusFrame(null);
    const measure = () => {
      if (!ready) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const target = canvas.querySelector(`[data-tutorial-target="${props.step.target}"]`) as HTMLElement | null;
        if (target !== current) {
          current?.removeAttribute('data-tutorial-active');
          current = target;
          current?.setAttribute('data-tutorial-active', 'true');
          current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        if (!current) { setFocusFrame(null); return; }
        const targetRect = current.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        setFocusFrame({ left: targetRect.left - canvasRect.left - 5, top: targetRect.top - canvasRect.top - 5, width: targetRect.width + 10, height: targetRect.height + 10, canvasWidth: canvasRect.width, canvasHeight: canvasRect.height });
      });
    };
    if (ready) measure();
    else settleTimer = window.setTimeout(() => { ready = true; measure(); }, 230);
    const mutation = new MutationObserver(measure);
    mutation.observe(canvas, { childList: true, subtree: true });
    const resize = new ResizeObserver(measure);
    resize.observe(canvas);
    document.addEventListener('scroll', measure, true);
    canvas.addEventListener('transitionend', measure, true);
    window.addEventListener('resize', measure);
    return () => { current?.removeAttribute('data-tutorial-active'); window.clearTimeout(settleTimer); cancelAnimationFrame(frame); mutation.disconnect(); resize.disconnect(); document.removeEventListener('scroll', measure, true); canvas.removeEventListener('transitionend', measure, true); window.removeEventListener('resize', measure); };
  }, [props.step.id, props.step.target]);

  const actionAllowed = (origin: Element) => Boolean(origin.closest('[data-tutorial-utility="help"], [data-tutorial-utility="finish"], [data-tutorial-coach]') || (props.step.interaction && origin.closest('[data-tutorial-target]')?.getAttribute('data-tutorial-target') === props.step.target));
  const confine = (event: React.MouseEvent<HTMLDivElement>) => {
    const origin = event.target as Element;
    const declaredTarget = origin.closest('[data-tutorial-target]');
    const control = origin.closest('a,button,input,select,textarea,[role="button"],tr[data-tutorial-target]');
    if (!control && !declaredTarget) return;
    if (!actionAllowed(origin)) { event.preventDefault(); event.stopPropagation(); }
  };
  const confineKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const origin = event.target as Element;
    if (actionAllowed(origin) || event.key === 'Tab' || event.key === 'Escape') return;
    if (origin.matches('input,select,textarea') || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); }
  };
  const activePath = screenNav(props.step.screen);
  const showCoach = props.step.screen !== 'finish' && focusFrame;
  return <div ref={canvasRef} onClickCapture={confine} onKeyDownCapture={confineKeyboard} onInputCapture={(event) => { if (!actionAllowed(event.target as Element)) { event.preventDefault(); event.stopPropagation(); } }} className="ui-panel relative min-h-0 flex-1 overflow-hidden rounded-xl bg-bg0" data-tutorial-canvas data-tutorial-screen={props.step.screen}>
    <div className="h-full overflow-auto" data-tutorial-scroll>
    <div className="min-h-full min-w-[760px] p-4">
      <TopNavView activePath={activePath} onNavigate={(href) => { if (href === '/library' && props.step.target === 'nav-library') props.onTarget(); }} onSignOut={() => undefined} />
      <div className="mx-auto mt-4 max-w-[1380px]"><TutorialScreen {...props} /></div>
    </div>
    </div>
    {showCoach ? <>
      <div aria-hidden className="pointer-events-none absolute left-0 top-0 z-20 bg-slate-950/[0.08]" style={{ width: '100%', height: Math.max(0, focusFrame.top) }} />
      <div aria-hidden className="pointer-events-none absolute bottom-0 left-0 z-20 bg-slate-950/[0.08]" style={{ width: '100%', top: Math.min(focusFrame.canvasHeight, focusFrame.top + focusFrame.height) }} />
      <div aria-hidden className="pointer-events-none absolute left-0 z-20 bg-slate-950/[0.08]" style={{ top: Math.max(0, focusFrame.top), width: Math.max(0, focusFrame.left), height: focusFrame.height }} />
      <div aria-hidden className="pointer-events-none absolute right-0 z-20 bg-slate-950/[0.08]" style={{ top: Math.max(0, focusFrame.top), left: Math.min(focusFrame.canvasWidth, focusFrame.left + focusFrame.width), height: focusFrame.height }} />
      <div data-tutorial-focus-frame aria-hidden className="pointer-events-none absolute z-[55] rounded-lg border-2 border-white shadow-[0_0_0_3px_#174ea6,0_0_0_6px_rgba(23,78,166,0.24)]" style={{ left: focusFrame.left, top: focusFrame.top, width: focusFrame.width, height: focusFrame.height }} />
      <TutorialCoachMark step={props.step} frame={focusFrame} busy={props.busy} onContinue={props.onContinue} />
    </> : null}
  </div>;
}

function screenNav(screen: TutorialStep['screen']) {
  if (screen.startsWith('library') || screen.startsWith('template') || screen === 'relations' || screen === 'linked-analyses' || screen === 'result-detail' || screen === 'results') return '/library';
  if (screen === 'finish') return '/tutoriais';
  return '/';
}

function TutorialScreen({ step, kind, run, fixture, documentUrl, onTarget, onRestart, onFinish }: {
  step: TutorialStep; kind: TutorialKind; run: Run; fixture: Fixture; documentUrl: string;
  busy: boolean; completed: boolean; onTarget: () => void; onContinue: () => void; onRestart: () => void; onFinish: () => void;
}) {
  switch (step.screen) {
    case 'home': return <HomeScreen fixture={fixture} onTarget={onTarget} target={step.target} />;
    case 'library-roots': return <LibraryRootsScreen target={step.target} onTarget={onTarget} />;
    case 'library-list': return <LibraryListScreen fixture={fixture} onTarget={onTarget} />;
    case 'library-detail':
    case 'relations': return <TutorialDocumentDetailView mode="official" fixture={fixture} documentUrl={documentUrl} target={step.target} onTarget={onTarget} />;
    case 'linked-analyses': return <LinkedAnalysesScreen fixture={fixture} />;
    case 'template-list': return <TemplateListScreen onTarget={onTarget} />;
    case 'template-detail': return <TutorialDocumentDetailView mode="template" fixture={fixture} documentUrl={documentUrl} target={step.target} onTarget={onTarget} />;
    case 'template-editor': return <TemplateEditorScreen fixture={fixture} documentUrl={documentUrl} onTarget={onTarget} />;
    case 'result-detail': return run.demoState.originOpened ? <TutorialHistory kind={kind} /> : <TutorialDocumentDetailView mode="generated" fixture={fixture} documentUrl={documentUrl} target={step.target} onTarget={onTarget} />;
    case 'analysis-type':
    case 'analysis-source':
    case 'analysis-support':
    case 'analysis-review': return <TutorialAnalysisWizard key={step.screen} kind={kind} fixture={fixture} target={step.target} onTarget={onTarget} />;
    case 'analysis-overview':
    case 'findings':
    case 'word':
    case 'pdf':
    case 'email': return <TutorialAnalysisWorkspace kind={kind} step={step} state={run.demoState} fixture={fixture} documentUrl={documentUrl} onTarget={onTarget} />;
    case 'results': return <ResultsScreen fixture={fixture} onTarget={onTarget} />;
    default: return <FinishScreen onFinish={onFinish} onRestart={onRestart} />;
  }
}

function PageTitle({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <PageHeader title={title} description={description} actions={action} />;
}

function HomeScreen({ fixture, target, onTarget }: { fixture: Fixture; target: string; onTarget: () => void }) {
  const row: AnalysisRow = { analysisId: 'tutorial-analysis', type: 'summary', mainDocumentName: fixture.sourceName, state: 'pronta_para_revisao', stateDetail: '', potentiallyAffected: false, itemCount: 2, archived: false, updatedAt: Number(fixture.metadata.updatedAt || Date.UTC(2026, 8, 10, 10, 0)), nextTask: { bucket: 'waiting_user', responsible: 'user', title: 'Rever resultados encontrados', explanation: 'Confirme as citações antes de criar o documento.', consequence: 'Depois poderá preparar o documento Word.', href: '/analyses/tutorial-analysis?view=extraction', helpContext: 'analysis.extraction.summary', actionId: null, count: 2 } };
  return <HomeView tutorial={{ analyses: [row], target: target === 'new-analysis' ? 'new-analysis' : undefined, onNewAnalysis: onTarget }} />;
}

function LibraryRootsScreen({ target, onTarget }: { target: string; onTarget: () => void }) {
  const rows: ListRow[] = [
    { kind: 'folder', id: 'officials', name: '1. Documentos oficiais Barraqueiro', path: '1. Documentos oficiais Barraqueiro', itemCount: 7, pendingCount: 0, modifiedAt: 0 },
    { kind: 'folder', id: 'templates', name: '2. Templates', path: '2. Templates', itemCount: 7, pendingCount: 0, modifiedAt: 0 },
    { kind: 'folder', id: 'results', name: '3. Resultados', path: '3. Resultados', itemCount: 9, pendingCount: 0, modifiedAt: 0 },
  ];
  const targets: Record<string, string> = { officials: 'official-folder', templates: 'template-folder', results: 'results-folder' };
  return <div><PageTitle title="Biblioteca" description="Espelho da pasta do OneDrive — as mesmas pastas e os mesmos ficheiros." action={<><button className="ui-btn-secondary">+ Nova pasta</button><button className="ui-btn-secondary">+ Carregar ficheiros</button><button className="ui-btn-primary">Sincronizar</button></>} /><h2 className="mb-4 text-base font-semibold">Biblioteca</h2><input className="ui-input mb-3" value="" readOnly placeholder="Filtrar por nome..." /><div data-tutorial-target="folders-overview"><DocumentList rows={rows} columns={['select','name','type','modified','size','state','actions']} selection={{ mode: 'multi', selectedIds: [], onChange: () => undefined }} sort={{ key: 'name', dir: 'asc' }} onOpenFolder={() => onTarget()} rowTarget={(row) => targets[row.id]} rowActions={() => []} emptyState={{ title: 'Pasta vazia' }} /></div></div>;
}

function LibraryListScreen({ fixture, onTarget }: { fixture: Fixture; onTarget: () => void }) {
  const row: FileRow = { kind: 'file', id: 'source', name: fixture.sourceName, title: String(fixture.metadata.title || ''), path: '1. Documentos oficiais Barraqueiro', docType: String(fixture.metadata.docType || 'other'), sourceKind: fixture.sourceMime.includes('pdf') ? 'pdf' : 'docx', size: 248320, modifiedAt: Number(fixture.metadata.updatedAt || 0), clientState: 'indexado', stateDetail: '', ocrPendingPages: 0, pageCount: Number(fixture.metadata.pageCount || 1), documentKind: 'official', templateId: '', outputState: '', templateEdited: false };
  return <div><PageTitle title="Biblioteca" description="Espelho da pasta do OneDrive — as mesmas pastas e os mesmos ficheiros." action={<><button className="ui-btn-secondary">+ Nova pasta</button><button className="ui-btn-secondary">+ Carregar ficheiros</button><button className="ui-btn-primary">Sincronizar</button></>} /><h2 className="mb-4 text-base font-semibold">1. Documentos oficiais Barraqueiro</h2><input className="ui-input mb-3" value="" readOnly placeholder="Filtrar por nome..." /><DocumentList rows={[row]} columns={['select','name','type','modified','size','state','actions']} selection={{ mode: 'multi', selectedIds: [], onChange: () => undefined }} sort={{ key: 'name', dir: 'asc' }} onOpenFile={onTarget} rowTarget={() => 'library-document'} onPreview={() => undefined} rowActions={() => []} emptyState={{ title: 'Pasta vazia' }} /></div>;
}

function TutorialDocumentDetailView({ mode, fixture, documentUrl, target, onTarget }: { mode: 'official' | 'template' | 'generated'; fixture: Fixture; documentUrl: string; target: string; onTarget: () => void }) {
  const isOfficial = mode === 'official';
  const isTemplate = mode === 'template';
  const documentId = `tutorial-${mode}`;
  const name = isTemplate ? 'nota-resumo.docx' : mode === 'generated' ? `Nota_${fixture.sourceName.replace(/\.[^.]+$/, '')}_v1a_final.pdf` : fixture.sourceName;
  const path = isTemplate ? '2. Templates/Resumo documental/nota-resumo.docx' : mode === 'generated' ? `3. Resultados/Resumo documental/Análise de treino/${name}` : `1. Documentos oficiais Barraqueiro/${fixture.sourceName}`;
  const payload: DocumentPayload = { ok: true, document: { documentId, name, title: isTemplate ? 'Nota informativa / Resumo' : mode === 'generated' ? `Nota — ${String(fixture.metadata.title || fixture.sourceName)}` : String(fixture.metadata.title || fixture.sourceName), docType: String(fixture.metadata.docType || 'other'), path, clientState: 'indexado', stateDetail: '', pageCount: Number(fixture.metadata.pageCount || 1), ocrPendingPages: 0, parentDocumentId: '', sourceKind: isTemplate ? 'docx' : fixture.sourceMime.includes('pdf') ? 'pdf' : 'docx', sha256: fixture.sourceSha256 || 'e3b0c44298fc1c149afbf4c8996fb9247852b855', subject: String(fixture.metadata.subject || 'Deveres e conservação de registos'), issuedDate: String(fixture.metadata.issuedDate || '2026-09-10'), effectiveDate: String(fixture.metadata.effectiveDate || ''), expiryDate: '', approvalStatus: mode === 'generated' ? 'aprovado' : 'rascunho', language: 'pt', entity: 'Grupo Barraqueiro', groupArea: 'Jurídico', versionLabel: 'v1a', extractorVersion: isOfficial ? 'legal-extractor-v1' : '', ocrQuality: 'n/a', structure: { headings: 3, lists: 1, tables: 0, tableConfidence: 'n/a' }, classifiedAt: Number(fixture.metadata.updatedAt || Date.UTC(2026, 8, 10, 10, 0)), topics: ['Conduta'], subtopics: ['Conservação de registos'], legislation: [], obligations: ['Conservar registos'], deadlines: [], correctedFields: [], references: [] }, pages: isOfficial ? [{ page: 1, ocr: false, pendingOcr: false, text: String(fixture.metadata.excerpt || '') }] : [], relations: isOfficial ? [{ relationId: 'tutorial-relation', otherDocumentId: 'tutorial-related', otherDocumentName: 'Regulamento complementar.pdf', status: 'proposed', confidence: { level: 'alta', basis: 'Referência encontrada e verificada no texto.' }, motives: [{ relationId: 'tutorial-relation', type: 'complementa', direction: 'outbound', confidence: { level: 'alta', basis: 'Referência encontrada e verificada no texto.' }, status: 'proposed', proposedBy: 'ai', evidence: { ai: { rationale: 'Os documentos tratam obrigações complementares.', citation: { documentId, page: 1, excerpt: String(fixture.metadata.excerpt || '').slice(0, 140), verified: true } } } }] }] : [], analyses: mode === 'generated' || isOfficial ? [{ analysisId: 'tutorial-analysis', type: 'summary', state: mode === 'generated' ? 'aprovada' : 'pronta_para_revisao', closedAt: mode === 'generated' ? Date.UTC(2026, 8, 10) : null, role: 'main', status: 'confirmed', mainDocumentName: fixture.sourceName, updatedAt: Date.UTC(2026, 8, 10), outputs: [] }] : [], generatedBy: mode === 'generated' ? { analysisId: 'tutorial-analysis', conversionId: 'tutorial-conversion', versionId: 'tutorial-version', type: 'summary', mainDocumentName: fixture.sourceName, versionLabel: 'v1a', approvalState: 'Aprovado' } : null, staleOcrPages: 0, editableTemplateId: isTemplate ? 'tutorial-template' : '', workCounts: { relations: isOfficial ? 1 : 0, analyses: isOfficial ? 1 : 0 } };
  return <DocumentDetailView documentId={documentId} tutorial={{ payload, docs: [{ documentId: 'tutorial-related', name: 'Regulamento complementar.pdf', path: '1. Documentos oficiais Barraqueiro' }], target, onAction: onTarget, previewContent: <DocumentSnapshot url={documentUrl} mime={fixture.sourceMime} name={fixture.sourceName} />, previewDownloadHref: documentUrl }} />;
}

function LinkedAnalysesScreen({ fixture }: { fixture: Fixture }) { return <div><PageTitle title={fixture.sourceName} description="Análises ligadas" /><section className="ui-panel rounded-xl p-5"><strong>Resumo documental</strong><p className="mt-1 mb-0 text-sm ui-text-muted">Aguarda revisão dos resultados encontrados.</p></section></div>; }

function TemplateListScreen({ onTarget }: { onTarget: () => void }) {
  const makeRow = (id: string, name: string, sourceKind: string): FileRow => ({ kind: 'file', id, name, title: '', path: `2. Templates/Resumo documental/${name}`, docType: 'other', sourceKind, size: 24576, modifiedAt: Date.UTC(2026, 8, 10), clientState: 'indexado', stateDetail: '', ocrPendingPages: 0, pageCount: 1, documentKind: 'template', templateId: id === 'template-document' ? 'tutorial-template' : '', outputState: '', templateEdited: false });
  const rows = [makeRow('template-document', 'nota-resumo.docx', 'docx'), makeRow('template-email', 'email-resumo.eml', 'email'), makeRow('template-fields', 'campos-resumo.json', 'json')];
  return <div><PageTitle title="Biblioteca" description="2. Templates / Resumo documental" /><DocumentList rows={rows} columns={['select','name','type','modified','size','state','actions']} selection={{ mode: 'multi', selectedIds: [], onChange: () => undefined }} sort={{ key: 'name', dir: 'asc' }} onOpenFile={(row) => { if (row.id === 'template-document') onTarget(); }} rowTarget={(row) => row.id === 'template-document' ? 'template-document' : undefined} onPreview={() => undefined} rowActions={() => []} emptyState={{ title: 'Pasta vazia' }} /></div>;
}

function TemplateEditorScreen({ fixture, documentUrl, onTarget }: { fixture: Fixture; documentUrl: string; onTarget: () => void }) {
  const blocks = [{ type: 'paragraph' as const, text: 'Nota informativa', style: 'Title' }, { type: 'paragraph' as const, text: 'A presente nota resume os pontos essenciais do documento analisado.', style: 'Normal' }, { type: 'loop' as const, name: 'statements', blocks: [{ type: 'paragraph' as const, text: '{content}', style: 'Normal' }] }];
  const preview = <div className="flex min-h-0 flex-1 flex-col"><p className="mb-2 mt-0 text-sm font-medium ui-text-muted">Pré-visualização do Template</p><DocumentSnapshot url={documentUrl} mime={fixture.sourceMime} name={fixture.sourceName} /></div>;
  return <TemplateEditorView templateId="tutorial-template" tutorial={{ name: 'Nota informativa / Resumo', blocks, preview, onSave: onTarget }} />;
}

function TutorialAnalysisWizard({ kind, fixture, target, onTarget }: { kind: TutorialKind; fixture: Fixture; target: string; onTarget: () => void }) {
  const sourceId = `tutorial-source-${kind}`;
  const relatedId = `tutorial-related-${kind}`;
  const doc = (documentId: string, name: string) => ({ documentId, name, title: name.replace(/\.[^.]+$/, ''), docType: 'other', sourceKind: name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx', pageCount: Number(fixture.metadata.pageCount || 3), path: '1. Documentos oficiais Barraqueiro', state: 'indexed' as const, clientState: 'indexado' as const, ocrPendingPages: 0, driveModifiedAt: Number(fixture.metadata.updatedAt || 0) });
  const relatedName = String(fixture.metadata.relatedName || 'Regulamento complementar.pdf');
  return <NewAnalysisWizard tutorial={{ analysisType: kind === 'revision' ? 'revision' : 'summary', docs: [doc(sourceId, fixture.sourceName), doc(relatedId, relatedName)], recommendations: [{ relationId: 'tutorial-relation', otherDocumentId: relatedId, otherDocumentName: relatedName, status: 'confirmed', confidence: { level: 'high', basis: 'Relação confirmada no treino' }, motives: [{ type: 'complements', evidence: { ai: { rationale: 'Documento de apoio confirmado.' } } }] }], target, onAction: () => onTarget() }} />;
}

function TutorialHistory({ kind }: { kind: TutorialKind }) {
  const at = Date.UTC(2026, 8, 10, 10, 0);
  const feed = [{ at, kind: 'created', pathLetter: 'a', data: {} }, { at: at + 1, kind: 'run_completed', pathLetter: 'a', data: { accepted: 2, rejected: 0 } }, { at: at + 2, kind: 'extraction_approved', pathLetter: 'a', data: { label: 'Resultados aprovados' } }, { at: at + 3, kind: 'version', pathLetter: 'a', data: { versionId: 'tutorial-version', label: 'v1a', origin: 'generated', pathLetter: 'a' } }, { at: at + 4, kind: 'conversion', pathLetter: 'a', data: { conversionId: 'tutorial-conversion', state: 'aprovado_para_envio' } }];
  const stages = ['configuracao', 'extracao', 'revisao', 'documento', 'pdf', 'email'].map((key, i) => ({ key, label: ['Configuração','Extração','Revisão','Documento','PDF','E-mail'][i], prompt: '', placeholder: '', restart: '' }));
  return <div><PageTitle title="Análise de origem" description="Versões e histórico" /><AnalysisTabs tab="historico" onSelect={() => undefined} /><HistoricoTab feed={feed} analysisType={kind === 'revision' ? 'revision' : 'summary'} paths={[{ letter: 'a', parentVersionId: '', parentLabel: '', parentStage: '' }]} stages={stages} activePath="a" viewingPath="a" selectedNodeId={null} onSelectNode={() => undefined} onViewPath={() => undefined} onActivatePath={() => undefined} /></div>;
}

function FindingsScreen({ kind, step, state, fixture, documentUrl, onTarget }: { kind: TutorialKind; step: TutorialStep; state: Record<string, unknown>; fixture: Fixture; documentUrl: string; onTarget: () => void }) {
  const revision = kind === 'revision';
  const retry = Number(state.retryCount || 0) > 0 || step.id === 'decide-retry' || step.id === 'approve-findings';
  const decided = retry ? state.legalDecisionRetry : state.legalDecision;
  const excerpt = String(fixture.metadata.excerpt || 'Conservar o registo durante o prazo legalmente aplicável.').slice(0, 220);
  const accepted = { itemId: 'tutorial-finding', seq: 1, kind: (revision ? 'matrix_line' : 'statement') as 'matrix_line' | 'statement', payload: { statement_type: 'obligation', content: revision ? 'A redação deve incluir uma obrigação atualizada de conservação do registo.' : 'O documento estabelece uma obrigação de conservação do registo.', source_document_id: 'tutorial-source', source_page: 1, source_excerpt: excerpt, evidence_quality: 'direct', requires_legal_decision: revision }, accepted: true, rejectionReason: '', decision: revision && decided !== 'accepted' ? 'pending' as const : 'accepted' as const };
  const excluded = { itemId: 'tutorial-excluded', seq: 2, kind: 'statement' as const, payload: { statement_type: 'other', content: 'Conclusão sem apoio suficiente', source_document_id: 'tutorial-source', source_page: 1, source_excerpt: excerpt, evidence_quality: 'indirect', requires_legal_decision: false }, accepted: false, rejectionReason: 'O excerto não foi encontrado na página indicada.', decision: 'rejected' as const };
  const data = { ok: true, extraction: { extractionId: retry ? 'tutorial-extraction-b' : 'tutorial-extraction-a', pathLetter: retry ? 'b' : 'a', label: retry ? 'v1b' : 'v1a', origin: 'agent' as const, acceptedCount: 1, rejectedCount: 1, approvedAt: null, approvedBy: '', rejectedAt: null, rejectedBy: '', rejectionReason: '', note: retry ? 'Nova tentativa: as decisões anteriores não foram copiadas.' : '', createdAt: Number(fixture.metadata.updatedAt || Date.UTC(2026, 8, 10, 10, 0)), fields: [] }, items: [accepted, excluded], sources: [{ documentId: 'tutorial-source', name: fixture.sourceName, title: String(fixture.metadata.title || fixture.sourceName) }] };
  const citationOpen = Boolean(state.citationOpened) && (step.id === 'citation' || step.id === 'inspect-citation');
  const approval = { id: 'approve_extraction' as const, label: 'Aprovar resultados', method: 'POST' as const, path: '', kind: 'primary' as const, enabled: !revision || decided === 'accepted', disabledReason: revision && decided !== 'accepted' ? 'Conclua a decisão jurídica pendente.' : undefined };
  return <div><PageTitle title={revision ? 'Rever a comparação' : 'Rever resultados encontrados'} description={`${fixture.sourceName} · ${retry ? 'Nova tentativa' : 'Tentativa inicial'}`} /><div className={`grid min-h-0 gap-4 ${citationOpen ? 'lg:grid-cols-[minmax(0,1fr)_minmax(26rem,1fr)]' : ''}`}><div className="min-w-0"><ExtractionReview analysisId="tutorial-analysis" path={retry ? 'b' : 'a'} canDecide onOpenSource={() => undefined} onRefresh={async () => undefined} approval={approval} onApprove={async () => onTarget()} onRejected={() => undefined} tutorial={{ data, target: step.target, onAction: onTarget }} /></div>{citationOpen ? <div><h3 data-tutorial-target="citation-preview" className="mb-2 text-sm font-semibold text-ink0">Fonte consultada</h3><DocumentSnapshot url={documentUrl} mime={fixture.sourceMime} name={fixture.sourceName} compact /></div> : null}</div></div>;
}

function OutputScreen({ mode, kind, fixture, documentUrl, onTarget }: { mode: 'word' | 'pdf'; kind: TutorialKind; fixture: Fixture; documentUrl: string; onTarget: () => void }) {
  const word = mode === 'word';
  const action = <button data-tutorial-target={word ? 'approve-word' : 'approve-pdf'} onClick={onTarget} className="ui-btn-primary w-full">{word ? 'Aprovar documento Word' : 'Aprovar PDF final'}</button>;
  const items = [{ key: 'word', title: 'Documento Word', status: word ? 'Pronto para revisão' : 'Aprovado', detail: 'Reveja o conteúdo e a apresentação do documento.', action: word ? action : undefined }, { key: 'pdf', title: 'PDF final', status: word ? 'Aguarda o Word' : 'Pronto para revisão', detail: 'Confirme a paginação e o ficheiro final.', action: word ? undefined : action }, { key: 'email', title: 'Rascunho de e-mail', status: 'Aguarda o PDF', detail: 'Só é preparado depois da aprovação do PDF.' }];
  return <div><PageTitle title={word ? 'Rever documento Word' : 'Rever PDF final'} description={`${kind === 'revision' ? 'Revisão / Atualização' : 'Resumo documental'} · ${fixture.sourceName}`} /><OutputSequence items={items} /><div className="mt-4 min-h-[28rem] overflow-hidden rounded-xl border border-line0 bg-surface-soft p-3"><DocumentSnapshot url={documentUrl} mime={fixture.sourceMime} name={fixture.sourceName} /></div></div>;
}

function EmailScreen({ kind, fixture, onTarget }: { kind: TutorialKind; fixture: Fixture; onTarget: () => void }) {
  const action = <button data-tutorial-target="download-email" onClick={onTarget} className="ui-btn-primary"><Mail size={16} /> Descarregar rascunho .eml</button>;
  const subject = kind === 'revision' ? 'Revisão jurídica para validação' : 'Resumo documental para validação';
  return <div><PageTitle title="Preparar rascunho de e-mail" description="Última confirmação antes da entrega humana." /><OutputSequence items={[{ key: 'word', title: 'Documento Word', status: 'Aprovado', detail: 'Conteúdo e apresentação aprovados.' }, { key: 'pdf', title: 'PDF final', status: 'Aprovado', detail: 'Ficheiro final pronto para anexar.' }, { key: 'email', title: 'Rascunho de e-mail', status: 'Pronto para descarregar', detail: 'Abra o ficheiro no Outlook para decidir o envio.', action }]} /><div className="mt-4"><EmailEditor analysisId="tutorial-analysis" tutorial={{ to: 'juridico@exemplo.pt', cc: '', subject, body: `Segue em anexo o resultado relativo a ${fixture.sourceName}.\n\nCom os melhores cumprimentos,` }} onSaved={async () => undefined} /></div></div>;
}

function TutorialAnalysisWorkspace({ kind, step, state, fixture, documentUrl, onTarget }: { kind: TutorialKind; step: TutorialStep; state: Record<string, unknown>; fixture: Fixture; documentUrl: string; onTarget: () => void }) {
  const revision = kind === 'revision';
  const [guidance, setGuidance] = useState('Voltar a verificar as conclusões e tornar a redação mais objetiva.');
  const [chatMessage, setChatMessage] = useState('Simplifique a conclusão principal e mantenha a citação jurídica.');
  const at = Date.UTC(2026, 8, 10, 10, 0);
  const branched = Boolean(state.branchCreated) || Number(state.retryCount || 0) > 0;
  const activePath = state.branchActivated ? 'b' : state.originalActivated ? 'a' : branched ? 'b' : 'a';
  const extractionApproved = Boolean(state.extractionApproved);
  const wordApproved = Boolean(state.wordApproved);
  const pdfApproved = Boolean(state.pdfApproved);
  const emailApproved = Boolean(state.emailApproved);
  const chatSent = Boolean(state.chatSent);
  const chatConfirmed = Boolean(state.chatConfirmed);
  const historyIds = new Set(['open-history', 'inspect-history', 'select-stage', 'return-stage', 'describe-restart', 'inspect-branch', 'view-original', 'activate-original', 'view-branch', 'activate-branch']);
  const findingsIds = new Set(['citation', 'inspect-citation', 'exclusion', 'legal-decision', 'reject-attempt', 'confirm-retry', 'decide-retry', 'approve-findings']);
  // The real analysis keeps the conversation visible while an artifact opens from the right.
  // Tutorials now do the same: opening the extraction does not replace the workspace.
  const tab: 'detalhes' | 'chat' | 'historico' = historyIds.has(step.id) ? 'historico' : 'chat';
  const stages: StageDef[] = ['configuracao', 'extracao', 'revisao', 'documento', 'pdf', 'email'].map((key, index) => ({ key, label: ['Configuração', 'Extração', 'Revisão', 'Documento', 'PDF', 'E-mail'][index], prompt: '', placeholder: '', restart: `Recomeçar em ${key}` }));
  const paths: PathInfo[] = [{ letter: 'a', parentVersionId: '', parentLabel: '', parentStage: '', createdAt: at }];
  if (branched) paths.push({ letter: 'b', parentVersionId: 'tutorial-version-a', parentLabel: 'v1a', parentStage: 'extracao', createdAt: at + 8 });
  const currentPath = branched ? 'b' : 'a';
  const currentExtractionId = `tutorial-extraction-${currentPath}`;
  const currentVersionId = `tutorial-version-${currentPath}`;
  const currentConversionId = `tutorial-conversion-${currentPath}`;
  const excerpt = String(fixture.metadata.excerpt || 'Conservar o registo durante o prazo legalmente aplicável.').slice(0, 220);
  const items: Item[] = [
    { itemId: 'tutorial-finding', kind: revision ? 'matrix_line' : 'statement', payload: { statement_type: 'obligation', content: revision ? 'A redação deve incluir a obrigação atualizada de conservação do registo.' : 'O documento estabelece uma obrigação de conservação do registo.', source_document_id: 'tutorial-source', source_page: 1, source_excerpt: excerpt, evidence_quality: 'direct', requires_legal_decision: revision }, accepted: true, rejectionReason: '', decision: revision && (branched ? state.legalDecisionRetry !== 'accepted' : state.legalDecision !== 'accepted') ? 'pending' : 'accepted' },
    { itemId: 'tutorial-excluded', kind: 'statement', payload: { statement_type: 'other', content: 'Conclusão sem apoio suficiente', source_document_id: 'tutorial-source', source_page: 1, source_excerpt: excerpt, evidence_quality: 'indirect', requires_legal_decision: false }, accepted: false, rejectionReason: 'O excerto não foi encontrado na página indicada.', decision: 'rejected' },
  ];
  const analysis: Analysis = { analysisId: 'tutorial-analysis', type: revision ? 'revision' : 'summary', mainDocumentId: 'tutorial-source', mainDocumentName: fixture.sourceName, state: emailApproved ? 'aprovada' : 'pronta_para_revisao', stateDetail: '', potentiallyAffected: false, affectedReason: '', instructions: 'Validar cada conclusão contra a fonte e conservar o rasto das decisões.' };
  const documents: AnalysisDocument[] = [{ documentId: 'tutorial-source', documentName: fixture.sourceName, role: 'main', status: 'confirmed', relationType: '', versionLabel: '', issuedDate: '', relevance: '', confidence: null, reason: '', excerpts: [] }];
  const conversions: Conversion[] = wordApproved ? [{ conversionId: currentConversionId, versionId: currentVersionId, pdfFilename: `${revision ? 'Revisao' : 'Resumo'}_${fixture.sourceName.replace(/\.[^.]+$/, '')}.pdf`, pdfPages: 2, pdfSize: 182400, state: pdfApproved ? 'aprovado_para_envio' : 'pronto_para_revisao', stateDetail: pdfApproved ? 'PDF aprovado para preparar o e-mail.' : 'Confirme o conteúdo e a paginação.', jsonFilename: 'dados-extraidos.json' }] : [];
  const feed: FeedEntry[] = [
    { at, kind: 'user_said', pathLetter: 'a', data: { text: revision ? 'Rever este documento e assinalar o que precisa de atualização.' : 'Preparar um resumo documental com as conclusões sustentadas.' } },
    { at: at + 1, kind: 'event:run_completed', pathLetter: 'a', data: { accepted: 1, rejected: 1 } },
    { at: at + 2, kind: 'extraction', pathLetter: 'a', data: { extractionId: 'tutorial-extraction-a', label: 'v1a', origin: 'agent', acceptedCount: 1, rejectedCount: 1, approvedAt: extractionApproved ? at + 3 : null, note: '' } },
    { at: at + 4, kind: 'version', pathLetter: 'a', data: { versionId: 'tutorial-version-a', label: 'v1a', filename: `${revision ? 'Revisao' : 'Resumo'}_${fixture.sourceName.replace(/\.[^.]+$/, '')}.docx`, origin: 'generated', note: 'Documento criado a partir dos resultados aprovados.', isFinal: wordApproved && !branched } },
  ];
  if (branched) {
    feed.push(
      { at: at + 8, kind: 'event:tracked_back', pathLetter: 'b', data: { stage: 'extracao', newPath: 'b', guidance: String(state.branchGuidance || guidance) } },
      { at: at + 9, kind: 'event:run_completed', pathLetter: 'b', data: { accepted: 1, rejected: 1 } },
      { at: at + 10, kind: 'extraction', pathLetter: 'b', data: { extractionId: 'tutorial-extraction-b', label: 'v1b', origin: 'agent', acceptedCount: 1, rejectedCount: 1, approvedAt: extractionApproved ? at + 11 : null, note: 'Nova tentativa; as decisões humanas foram pedidas novamente.' } },
      { at: at + 12, kind: 'version', pathLetter: 'b', data: { versionId: 'tutorial-version-b', label: 'v1b', filename: `${revision ? 'Revisao' : 'Resumo'}_${fixture.sourceName.replace(/\.[^.]+$/, '')}_v1b.docx`, origin: chatConfirmed ? 'chat_change' : 'generated', note: chatConfirmed ? 'Versão refeita a partir do pedido no chat.' : 'Documento da tentativa alternativa.', isFinal: wordApproved } },
    );
  }
  if (chatSent) feed.push({ at: at + 13, kind: 'turn', pathLetter: currentPath, data: { turnId: 'tutorial-turn', userMessage: chatMessage, reply: 'Posso aplicar esta alteração ao documento e criar uma nova versão, mantendo as citações existentes.', status: chatConfirmed ? 'applied' : 'pending_confirmation', impact: { reasons: ['A alteração afeta a redação do documento Word.'], appOverrode: false } } });
  if (wordApproved) feed.push({ at: at + 14, kind: 'conversion', pathLetter: currentPath, data: conversions[0] as unknown as Record<string, unknown> });
  if (pdfApproved) feed.push({ at: at + 15, kind: 'email', pathLetter: currentPath, data: { to: 'juridico@exemplo.pt', cc: '', subject: revision ? 'Revisão jurídica para validação' : 'Resumo documental para validação', body: `Segue em anexo o resultado relativo a ${fixture.sourceName}.`, attachment: { pdfName: conversions[0]?.pdfFilename || 'resultado.pdf', pdfSize: 182400 }, approved: emailApproved } });
  const phaseIndex = pdfApproved ? 5 : wordApproved ? 4 : extractionApproved ? 3 : 2;
  const phaseKeys = ['configuracao', 'extracao', 'revisao', 'documento', 'pdf', 'email'] as const;
  const task = emailApproved ? { title: 'Descarregar o rascunho', explanation: 'A análise está concluída; o ficheiro .eml está disponível no cartão.', consequence: 'O Outlook abre o rascunho para a decisão humana de envio.', helpContext: 'analysis.email' as const }
    : pdfApproved ? { title: 'Aprovar o e-mail', explanation: 'Confirme o rascunho para concluir a análise.', consequence: 'A descarga do ficheiro .eml fica disponível como ação separada.', helpContext: 'analysis.email' as const }
    : wordApproved ? { title: 'Rever o PDF final', explanation: 'Confirme o conteúdo e a paginação antes de aprovar.', consequence: 'A aplicação prepara o rascunho de e-mail.', helpContext: 'analysis.pdf' as const }
      : extractionApproved ? { title: 'Rever o documento Word', explanation: 'Consulte a versão criada e confirme o conteúdo.', consequence: 'A aplicação converte a versão aprovada em PDF.', helpContext: 'analysis.document' as const }
        : { title: 'Rever resultados encontrados', explanation: 'Valide as citações e resolva todas as decisões pendentes.', consequence: 'Depois poderá preparar o documento Word.', helpContext: revision ? 'analysis.extraction.revision' as const : 'analysis.extraction.summary' as const };
  const workflow = {
    version: 1, analysisId: analysis.analysisId, state: analysis.state, stateLabel: task.title, path: currentPath, activePath, isActivePath: true, closed: emailApproved,
    nextTask: { bucket: 'waiting_user', responsible: 'user', ...task, href: '', actionId: null, count: 1 },
    phase: { key: phaseKeys[phaseIndex], label: stages[phaseIndex].label, index: phaseIndex, status: 'active', actor: 'user', headline: task.title },
    phases: stages.map((stage, index) => ({ key: stage.key, label: stage.label, status: index < phaseIndex ? 'done' : index === phaseIndex ? 'active' : 'pending' })),
    actions: [], blockers: [], notices: [], writes: { allowed: !emailApproved, reason: emailApproved ? 'A análise está concluída.' : '' }, progress: null, failure: null,
    surfaces: {
      chat: { id: 'chat_send', label: 'Enviar', method: 'POST', path: '', kind: 'primary', enabled: true },
      setFinal: { id: 'set_final', label: 'Aprovar documento Word', method: 'POST', path: '', kind: 'primary', enabled: true },
      approvePdf: { id: 'approve_pdf', label: 'Aprovar PDF final', method: 'POST', path: '', kind: 'primary', enabled: true },
      approveEmail: { id: 'approve_email', label: 'Aprovar e-mail', method: 'POST', path: '', kind: 'primary', enabled: !emailApproved },
    },
  } as WorkflowStatus;
  const citationOpen = Boolean(state.citationOpened) && step.id === 'inspect-citation';
  const itemData = { ok: true, extraction: { extractionId: currentExtractionId, pathLetter: currentPath, label: `v1${currentPath}`, origin: 'agent' as const, acceptedCount: 1, rejectedCount: 1, approvedAt: null, approvedBy: '', rejectedAt: null, rejectedBy: '', rejectionReason: '', note: branched ? 'Nova tentativa: as decisões anteriores não foram copiadas.' : '', createdAt: at, fields: [] }, items: items.map((item, index) => ({ ...item, seq: index + 1 })), sources: [{ documentId: 'tutorial-source', name: fixture.sourceName, title: String(fixture.metadata.title || fixture.sourceName) }] };
  const showReturnPanel = step.id === 'return-stage' || step.id === 'describe-restart';
  const viewingPath = step.id === 'activate-original' ? 'a' : step.id === 'activate-branch' ? 'b' : activePath;
  const versions = feed.filter((entry) => entry.kind === 'version').map((entry) => ({ versionId: String(entry.data.versionId), label: String(entry.data.label), isFinal: Boolean(entry.data.isFinal), origin: String(entry.data.origin), templateId: 'tutorial-template', templateVersion: 1 }));
  const feedTarget = step.id === 'open-work' ? 'open-findings' : step.target;
  const act = () => onTarget();
  const openPanel = (panel: Panel) => {
    if ((panel.mode === 'items' && step.id === 'open-work')
      || (panel.mode === 'version' && step.id === 'open-word')
      || (panel.mode === 'pdf' && step.id === 'open-pdf')
      || (panel.mode === 'email' && step.id === 'open-email')) onTarget();
  };
  const artifactPanel = step.id === 'inspect-word' ? 'word' : step.id === 'inspect-pdf' ? 'pdf' : step.id === 'edit-email' ? 'email' : null;
  const extractionPanelOpen = findingsIds.has(step.id);

  return <div className="flex min-h-0 flex-1 flex-col">
    <PageHeader title={`${revision ? 'Revisão / Atualização' : 'Resumo documental'} — ${fixture.sourceName}`} description={workflow.stateLabel} actions={<div className="flex items-center gap-2"><ContextHelpLink context={task.helpContext} label="Ajuda desta página" />{paths.length > 1 ? <span className="ui-pill-accent rounded-md px-2.5 py-1 text-sm">Tentativa {activePath.toUpperCase()}</span> : null}</div>} />
    <PhaseStepper phases={workflow.phases} />
    <AnalysisTabs tab={tab} tutorialTargets={{ historico: step.id === 'open-history' ? 'history-tab' : undefined }} onSelect={(selected) => { if (step.id === 'open-history' && selected === 'historico') onTarget(); }} />
    {tab === 'detalhes' ? <DetalhesTab stateLabel={workflow.stateLabel} analysis={analysis} documents={documents} items={items} versions={versions} conversions={conversions} paths={paths} activePath={activePath} draft={pdfApproved ? { allowed: true, summary: { pdfName: conversions[0]?.pdfFilename || 'resultado.pdf', pdfSize: 182400, docxVersionNo: 1 } } : { allowed: false, reason: 'Aprove primeiro o PDF final.' }} onOpen={openPanel} /> : null}
    {tab === 'historico' ? <div className="relative min-h-[32rem] flex-1"><HistoricoTab feed={feed} analysisType={analysis.type} paths={paths} stages={stages} activePath={activePath} viewingPath={viewingPath} selectedNodeId={null} tutorialNodeTarget={step.id === 'select-stage' ? 'history-graph' : undefined} tutorialNodeStage="extracao" tutorialPathTarget={step.id === 'inspect-history' || step.id === 'inspect-branch' || step.id === 'view-original' || step.id === 'view-branch' ? 'history-graph' : undefined} tutorialPathLetter={step.id === 'inspect-branch' || step.id === 'view-branch' ? 'b' : 'a'} tutorialActivatePathTarget={step.id === 'activate-original' || step.id === 'activate-branch' ? step.target : undefined} onSelectNode={() => { if (step.id === 'select-stage') onTarget(); }} onViewPath={(letter) => { if ((step.id === 'view-original' && letter === 'a') || (step.id === 'view-branch' && letter === 'b')) onTarget(); }} onActivatePath={() => onTarget()} />
      {showReturnPanel ? <SlideOver open contained modal={false} title="Fase da análise" onClose={() => undefined}><div className="grid gap-4 overflow-y-auto p-5"><div><p className="m-0 text-xs font-semibold uppercase tracking-wide text-accent-strong">Extração</p><h2 className="mt-1 mb-0 text-xl font-semibold">Análise processada</h2><p className="mt-2 mb-0 ui-text-muted">1 resultado aceite e 1 excluído. Pode regressar a este ponto sem apagar a tentativa atual.</p></div>{step.id === 'return-stage' ? <button type="button" data-tutorial-target="return-here" onClick={onTarget} className="ui-btn-primary w-fit">Voltar aqui</button> : <form data-tutorial-target="restart-guidance" onSubmit={(event) => { event.preventDefault(); if (guidance.trim()) onTarget(); }} className="grid gap-2"><label className="text-sm font-medium">O que deve ser diferente na nova tentativa?</label><textarea value={guidance} onChange={(event) => setGuidance(event.target.value)} rows={4} className="ui-input" /><button type="submit" className="ui-btn-primary w-fit">Criar nova tentativa</button></form>}</div></SlideOver> : null}
    </div> : null}
    {tab === 'chat' ? <div className="ui-panel min-h-[32rem] flex-1 overflow-y-auto rounded-xl p-4"><div className="mx-auto grid max-w-4xl gap-3">{feed.map((entry, index) => <FeedBubble key={`${entry.at}-${index}`} entry={entry} analysisType={analysis.type} analysisId={analysis.analysisId} writes={workflow.writes} current={{ extractionId: currentExtractionId, versionId: currentVersionId, conversionId: currentConversionId }} surfaces={workflow.surfaces} busy="" tutorialTarget={entry.kind === 'extraction' && step.id === 'open-work' ? feedTarget : entry.kind === 'version' && step.id === 'approve-word' ? feedTarget : entry.kind === 'conversion' && step.id === 'approve-pdf' ? feedTarget : entry.kind === 'email' && (step.id === 'approve-email' || step.id === 'prepare-email') ? feedTarget : entry.kind === 'turn' && step.id === 'confirm-chat' ? feedTarget : undefined} tutorialOpenTarget={entry.kind === 'version' && step.id === 'open-word' ? 'open-word' : entry.kind === 'conversion' && step.id === 'open-pdf' ? 'open-pdf' : entry.kind === 'email' && step.id === 'open-email' ? 'open-email' : undefined} onOpen={openPanel} onAct={act} onDownload={act} onDecideTurn={act} />)}{step.id === 'redo-chat' ? <form data-tutorial-target="chat-composer" onSubmit={(event) => { event.preventDefault(); if (chatMessage.trim()) onTarget(); }} className="sticky bottom-0 mt-3 grid gap-2 rounded-xl border border-line0 bg-surface p-3 shadow-lg"><label className="text-sm font-medium">Peça uma alteração diretamente no chat</label><textarea value={chatMessage} onChange={(event) => setChatMessage(event.target.value)} rows={3} className="ui-input" /><div className="flex justify-end"><button type="submit" className="ui-btn-primary">Enviar pedido</button></div></form> : null}</div></div> : null}
    {extractionPanelOpen ? <SlideOver open contained modal={false} tutorialTarget={citationOpen ? 'citation-preview' : undefined} title={citationOpen ? 'Documento fonte' : 'Rever resultados encontrados'} leading={citationOpen ? <button type="button" className="ui-btn-secondary rounded-md px-2.5 py-1 text-sm">← Voltar</button> : undefined} onClose={() => undefined}><div className="min-h-0 flex-1 overflow-y-auto p-4">{citationOpen ? <DocumentSnapshot url={documentUrl} mime={fixture.sourceMime} name={fixture.sourceName} /> : <ExtractionReview analysisId="tutorial-analysis" path={currentPath} canDecide onOpenSource={() => undefined} onRefresh={async () => undefined} approval={{ id: 'approve_extraction', label: 'Aprovar resultados', method: 'POST', path: '', kind: 'primary', enabled: !revision || (branched ? state.legalDecisionRetry === 'accepted' : state.legalDecision === 'accepted') }} onApprove={async () => onTarget()} onRejected={() => undefined} tutorial={{ data: itemData, target: step.target, onAction: onTarget }} />}</div></SlideOver> : null}
    {artifactPanel ? <SlideOver open contained modal={false} tutorialTarget={artifactPanel === 'email' ? undefined : 'artifact-preview'} title={artifactPanel === 'word' ? 'Pré-visualização' : artifactPanel === 'pdf' ? 'PDF' : 'Rascunho de e-mail'} onClose={() => undefined}><div className="min-h-0 flex-1 overflow-y-auto p-4">{artifactPanel === 'email' ? <EmailEditor analysisId="tutorial-analysis" tutorial={{ to: 'juridico@exemplo.pt', cc: '', subject: revision ? 'Revisão jurídica para validação' : 'Resumo documental para validação', body: `Segue em anexo o resultado relativo a ${fixture.sourceName}.\n\nCom os melhores cumprimentos,`, target: 'save-email' }} onSaved={async () => onTarget()} /> : <DocumentSnapshot url={documentUrl} mime={fixture.sourceMime} name={fixture.sourceName} />}</div></SlideOver> : null}
  </div>;
}

function ResultsScreen({ fixture, onTarget }: { fixture: Fixture; onTarget: () => void }) {
  const name = `Nota_${fixture.sourceName.replace(/\.[^.]+$/, '')}_v1a_final.pdf`;
  const row: FileRow = { kind: 'file', id: 'tutorial-result', name, title: `Nota — ${String(fixture.metadata.title || fixture.sourceName)}`, path: '3. Resultados/Resumo documental/Análise de treino', docType: 'other', sourceKind: 'pdf', size: 182400, modifiedAt: Number(fixture.metadata.updatedAt || 0), clientState: 'indexado', stateDetail: '', ocrPendingPages: 0, pageCount: 2, documentKind: 'generated', templateId: '', outputState: 'aprovado_para_envio', templateEdited: false };
  return <div><PageTitle title="Biblioteca" description="Espelho da pasta do OneDrive — as mesmas pastas e os mesmos ficheiros." /><h2 className="mb-4 text-base font-semibold">3. Resultados / Resumo documental / Análise de treino</h2><DocumentList rows={[row]} columns={['select','name','type','modified','size','state','actions']} selection={{ mode: 'multi', selectedIds: [], onChange: () => undefined }} sort={{ key: 'name', dir: 'asc' }} onOpenFile={onTarget} rowTarget={() => 'result-document'} onPreview={() => undefined} rowActions={() => []} emptyState={{ title: 'Pasta vazia' }} /></div>;
}

function FinishScreen({ onFinish, onRestart }: { onFinish: () => void; onRestart: () => void }) {
  return <div className="grid min-h-[32rem] place-items-center"><section data-tutorial-target="finish-card" data-tutorial-utility="finish" className="ui-panel max-w-xl rounded-xl p-8 text-center"><span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-green-100 text-success"><Check size={30} /></span><h2 className="mb-2 mt-4 text-2xl">Tutorial concluído</h2><p className="m-0 ui-text-muted">Praticou o percurso completo sem alterar análises, relações, versões, mensagens ou ficheiros reais.</p><div className="mt-5 flex flex-wrap justify-center gap-2"><button onClick={onFinish} className="ui-btn-primary">Concluir e sair</button><button onClick={onRestart} className="ui-btn-secondary">Praticar novamente</button></div></section></div>;
}

function DocumentSnapshot({ url, mime, name, compact = false }: { url: string; mime: string; name: string; compact?: boolean }) {
  if (mime === 'application/pdf') return <iframe src={`${url}#view=FitV&navpanes=0`} title={`Documento de treino — ${name}`} className={`${compact ? 'h-[26rem]' : 'h-[min(70vh,52rem)]'} w-full rounded-lg border border-line0 bg-white`} />;
  return <div className={`${compact ? 'min-h-72' : 'min-h-96'} grid place-items-center rounded-lg border border-line0 bg-white p-6 text-center text-slate-700`}><div><FileText className="mx-auto" size={32} /><p className="mt-3 mb-0 font-medium">{name}</p><p className="mt-2 mb-0 text-sm">Cópia privada e imutável do documento de treino.</p><a href={url} target="_blank" rel="noreferrer" className="mt-3 inline-block text-sm underline">Abrir cópia</a></div></div>;
}
