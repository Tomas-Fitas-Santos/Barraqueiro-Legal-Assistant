'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { OutputSequence } from '@/components/analyses/output-sequence';
import { ContextHelpLink } from '@/components/help/context-help-link';
import {
  WorkflowGraph,
  lineageFeed,
  pathDisplayName,
  pathLineage,
  toneOf,
  type GraphNode,
} from '@/components/analyses/workflow-graph';
import { ExtractionReview } from '@/components/analyses/extraction-review';
import { DocxPreview } from '@/components/library/docx-preview';
import { DocumentPreview } from '@/components/library/document-preview';
import { SLIDE_OVER_FRAME_HEIGHT, SlideOver } from '@/components/ui/slide-over';
import { eventChatSentence, eventVoice, msg, type WorkflowStatus } from '@/lib/workflow';
import { ANALYSIS_JOURNEY_LABELS, VERSION_LANGUAGE } from '@/lib/product-language';
import { EmptyState, PageHeader } from '@/components/ui/page';
import {
  ANALYSIS_STATE_LABELS,
  ANALYSIS_TYPE_LABELS,
  CONVERSION_STATE_LABELS,
  RELATION_CONFIDENCE_LABELS,
  RELEVANCE_LABELS,
  relatedDocumentRelationLabel,
  STATEMENT_TYPE_LABELS,
  type AnalysisState,
  type AnalysisType,
  type Relevance,
} from '@/lib/types';

// The chat-driven workflow surface (phase 9): every step of the deterministic workflow —
// system events, approval gates, generated documents, the revision chat — renders as one
// chronological chat. Anything citable opens the source in the side panel (documents at
// the cited page with the excerpt highlighted; versions as an in-app preview; PDFs
// inline). Histórico is the second tab: the full trail plus the version tree per path,
// with track-back forking (v1a → v2a; fork → v1b).

export type Analysis = {
  analysisId: string;
  type: AnalysisType;
  mainDocumentId: string;
  mainDocumentName: string;
  state: AnalysisState;
  stateDetail: string;
  potentiallyAffected: boolean;
  affectedReason: string;
  instructions: string;
};

export type FeedEntry = { at: number; kind: string; pathLetter: string; data: Record<string, unknown> };

export type AnalysisDocument = {
  documentId: string;
  documentName: string;
  role: 'main' | 'related';
  status: 'pending' | 'confirmed' | 'excluded';
  relationType: string;
  versionLabel: string;
  issuedDate: string;
  relevance: Relevance | '';
  confidence: { level: string; basis: string } | null;
  reason: string;
  excerpts: Array<{ documentId: string; page: number; text: string }>;
};

export type Item = {
  itemId: string;
  kind: 'statement' | 'matrix_line';
  payload: Record<string, unknown>;
  accepted: boolean;
  rejectionReason: string;
  decision: 'pending' | 'accepted' | 'rejected';
};

export type Conversion = {
  conversionId: string;
  versionId: string;
  pdfFilename: string;
  pdfPages: number;
  pdfSize: number;
  state: 'pendente' | 'em_conversao' | 'pronto_para_revisao' | 'aprovado_para_envio' | 'erro' | 'desatualizado';
  stateDetail: string;
  jsonFilename: string;
};

export type PathInfo = { letter: string; parentVersionId: string; parentLabel: string; parentStage: string; createdAt?: number };

export type Timeline = {
  ok: boolean;
  analysis: Analysis;
  /** The server's answer to "which phase is this, and what can be done here" (see
   *  src/lib/workflow). The client renders it and no longer derives its own. */
  workflow: WorkflowStatus;
  feed: FeedEntry[];
  /** The same trail with fixed failures dropped and retries folded — what the chat says. */
  chatFeed: FeedEntry[];
  documents: AnalysisDocument[];
  items: Item[];
  conversions: Conversion[];
  paths: PathInfo[];
  activePath: string;
  draft: { allowed: true; summary: { pdfName: string; pdfSize: number; docxVersionNo: number } } | { allowed: false; reason: string };
};

export type StageDef = { key: string; label: string; prompt: string; placeholder: string; restart: string };

export type Panel =
  | { mode: 'document'; documentId: string; page?: number; excerpt?: string }
  | { mode: 'version'; versionId: string }
  | { mode: 'docx'; versionId: string; title: string }
  | { mode: 'pdf'; url: string; title: string }
  | { mode: 'items' }
  | { mode: 'edit'; versionId: string }
  | { mode: 'email' }
  | { mode: 'node'; node: GraphNode };

const PANEL_TITLES: Record<Panel['mode'], string> = {
  document: 'Documento fonte',
  version: 'Pré-visualização',
  docx: 'Documento Word',
  pdf: 'PDF',
  items: 'Rever resultados encontrados',
  edit: 'Editar documento',
  email: 'Rascunho de e-mail',
  node: 'Fase da análise',
};

// Version identity, shown the same way everywhere: a branch glyph, the path letter as a
// coloured chip, and the number within that path (v1a → "⑂ A · 1").
const PATH_TONES = ['ui-pill-accent', 'ui-pill-ok', 'ui-pill-info', 'ui-pill-warn'];

export function pathTone(letter: string): string {
  const index = Math.max(0, letter.charCodeAt(0) - 'a'.charCodeAt(0));
  return PATH_TONES[index % PATH_TONES.length];
}

/**
 * How sure the app is that a documental link is real — shown wherever a related document
 * is, INCLUDING after it has been decided. A decision and the evidence behind it are
 * different facts: confirming a document does not turn "we found no reference to it
 * anywhere" into something else, and that is exactly the case worth still seeing.
 */
function ConfidencePill({
  confidence,
  className = '',
  small = false,
}: {
  confidence: { level: string; basis: string } | null;
  className?: string;
  small?: boolean;
}) {
  if (!confidence) return null;
  return (
    <span
      className={`${className} rounded-md ${small ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-0.5 text-sm'} ${
        confidence.level === 'nao_confirmada' ? 'ui-pill-warn' : 'ui-pill-info'
      }`}
      title={confidence.basis}
    >
      {RELATION_CONFIDENCE_LABELS[confidence.level] || confidence.level}
    </span>
  );
}

export function VersionChip({ label }: { label: string }) {
  const match = /^v(\d+)([a-z])$/.exec(label);
  const seq = match ? match[1] : label;
  const letter = match ? match[2] : '';
  return (
    <span className={`${letter ? pathTone(letter) : 'ui-pill-info'} inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-sm`}>
      {letter ? <span aria-hidden>⑂</span> : null}
      {letter ? letter.toUpperCase() : ''}
      <span className="opacity-60">·</span>
      {seq}
    </span>
  );
}

const CONV_TONES: Record<Conversion['state'], string> = {
  pendente: 'ui-pill-info',
  em_conversao: 'ui-pill-accent',
  pronto_para_revisao: 'ui-pill-accent',
  aprovado_para_envio: 'ui-pill-ok',
  erro: 'ui-pill-error',
  desatualizado: 'ui-pill-warn',
};

export function PhaseStepper({ phases }: { phases: WorkflowStatus['phases'] }) {
  return (
    <ol className="ui-panel m-0 mb-4 flex list-none items-center justify-center gap-2 overflow-x-auto rounded-xl px-4 py-2.5">
      {phases.map((phase, i) => {
        const done = phase.status === 'done';
        const here = phase.status !== 'done' && phase.status !== 'pending';
        return (
          <li key={phase.key} className="flex shrink-0 items-center gap-2">
            <span
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-sm ${
                here
                  ? `${phase.status === 'failed' ? 'ui-pill-error' : 'bg-accent-soft text-accent-strong'} font-medium`
                  : done
                    ? 'text-ink1'
                    : 'ui-text-subtle'
              }`}
              title={phase.status}
            >
              <span
                className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${
                  done
                    ? 'bg-accent text-white'
                    : here
                      ? `border ${phase.status === 'failed' ? 'border-danger text-danger' : 'border-accent text-accent-strong'}`
                      : 'border border-line1'
                }`}
              >
                {done ? '✓' : phase.status === 'failed' ? '!' : i + 1}
              </span>
              {ANALYSIS_JOURNEY_LABELS[phase.key] || phase.label}
            </span>
            {i < phases.length - 1 ? <span aria-hidden className="h-px w-5 bg-line1" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function AnalysisTabs({ tab, onSelect, tutorialTargets }: { tab: 'detalhes' | 'chat' | 'historico'; onSelect: (tab: 'detalhes' | 'chat' | 'historico') => void; tutorialTargets?: Partial<Record<'detalhes' | 'chat' | 'historico', string>> }) {
  return <div className="mb-4 flex items-center gap-1.5">{([['detalhes', 'Detalhes'], ['chat', 'Análise'], ['historico', VERSION_LANGUAGE.section]] as const).map(([key, label]) => <button key={key} type="button" data-tutorial-target={tutorialTargets?.[key] || (key === 'chat' ? 'open-findings' : undefined)} onClick={() => onSelect(key)} className={`rounded-md px-4 py-1.5 text-base ${tab === key ? 'bg-accent-soft font-medium text-accent-strong' : 'ui-btn-secondary'}`}>{label}</button>)}</div>;
}

export function AnalysisChatView({ analysisId }: { analysisId: string }) {
  const [data, setData] = useState<Timeline | null>(null);
  const [tab, setTab] = useState<'detalhes' | 'chat' | 'historico'>('detalhes');
  // A STACK, so opening a reference from the review panel can come back to it.
  const [panelStack, setPanelStack] = useState<Panel[]>([]);
  const panel = panelStack[panelStack.length - 1] || null;
  const pushPanel = useCallback((next: Panel) => setPanelStack((stack) => [...stack, next]), []);
  const replacePanel = useCallback((next: Panel) => setPanelStack([next]), []);
  const popPanel = useCallback(() => setPanelStack((stack) => stack.slice(0, -1)), []);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [gone, setGone] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [stages, setStages] = useState<StageDef[]>([]);
  // Which path the user is READING. Defaults to the one being worked on; picking another
  // in Histórico narrows the Análise tab to that path's lineage.
  const [viewingPath, setViewingPath] = useState<string | null>(null);
  const feedEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetch(`/api/analyses/${analysisId}/track-back`)
      .then((r) => r.json())
      .then((d) => d.ok && setStages(d.stages));
  }, [analysisId]);

  const refresh = useCallback(async () => {
    const query = viewingPath ? `?path=${encodeURIComponent(viewingPath)}` : '';
    const res = (await fetch(`/api/analyses/${analysisId}/timeline${query}`).then((r) => r.json())) as Timeline;
    if (res.ok) setData(res);
    else setGone(true);
  }, [analysisId, viewingPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live progress: the server says whether an operation is actually running and how often
  // to ask again. An operation killed by a restart reports no progress at all, so the chat
  // stops polling a corpse — which it used to do forever, from a hardcoded state list.
  const pollAfterMs = data?.workflow.progress?.pollAfterMs || 0;
  const working = pollAfterMs > 0;
  useEffect(() => {
    if (!pollAfterMs) return;
    const timer = setInterval(() => void refresh(), pollAfterMs);
    return () => clearInterval(timer);
  }, [pollAfterMs, refresh]);

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ block: 'end' });
  }, [data?.feed.length, tab, working]);

  async function act(label: string, path: string, init?: RequestInit) {
    setBusy(label);
    setNotice('');
    try {
      const res = await fetch(path, { method: 'POST', ...init }).then((r) => r.json());
      if (!res.ok) setNotice(res.error || `${label} falhou.`);
      await refresh();
    } finally {
      setBusy('');
    }
  }

  async function patch(path: string, body: Record<string, unknown>) {
    setNotice('');
    const res = await fetch(path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    if (!res.ok) setNotice(res.error || 'A ação falhou.');
    await refresh();
  }

  async function sendChat() {
    const message = chatInput.trim();
    if (!message) return;
    setBusy('chat');
    setNotice('');
    try {
      const res = await fetch(`/api/analyses/${analysisId}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      }).then((r) => r.json());
      if (!res.ok) setNotice(res.error || 'O pedido falhou.');
      else setChatInput('');
      await refresh();
    } finally {
      setBusy('');
    }
  }

  async function trackBack(stage: { key: string; restart: string }, guidance: string) {
    setBusy('trackback');
    setNotice('');
    try {
      const res = await fetch(`/api/analyses/${analysisId}/track-back`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage: stage.key, guidance }),
      }).then((r) => r.json());
      if (!res.ok) {
        setNotice(res.error || 'Não foi possível voltar a esta fase.');
        return;
      }
      // Restart the work the stage implies; 'review_only' just reopens the decisions.
      const kick =
        res.restart === 'relations'
          ? `/api/analyses/${analysisId}/identify-relations`
          : res.restart === 'run'
            ? `/api/analyses/${analysisId}/run`
            : res.restart === 'generate'
              ? `/api/analyses/${analysisId}/versions`
              : '';
      if (kick) void fetch(kick, { method: 'POST' });
      setTab('chat');
      await refresh();
    } finally {
      setBusy('');
    }
  }

  /** An action whose response is a FILE: download it instead of parsing it as JSON. */
  async function actDownload(label: string, path: string) {
    setBusy(label);
    setNotice('');
    try {
      const res = await fetch(path, { method: 'POST' });
      if (!res.ok) {
        setNotice((((await res.json().catch(() => ({}))) as { error?: string }).error) || 'A ação falhou.');
        return;
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'rascunho.eml';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      await refresh();
    } finally {
      setBusy('');
    }
  }

  if (gone) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader
          title="Análise eliminada"
          description="Esta análise já não está disponível."
          actions={
            <Link href="/" className="ui-btn-secondary rounded-md px-3.5 py-1.5 text-base no-underline">
              ← Processos
            </Link>
          }
        />
        <EmptyState
          title="Esta análise foi eliminada"
          description="Os documentos que gerou continuam na biblioteca; a análise em si não pode ser aberta nem alterada."
        />
      </div>
    );
  }
  if (!data) return null;
  const { analysis, documents, items, paths, activePath, workflow } = data;
  const shownPath = viewingPath || activePath;
  const shownPathInfo = paths.find((path) => path.letter === shownPath);
  const activePathInfo = paths.find((path) => path.letter === activePath);
  // The Análise tab shows one path at a time: this path plus what its ancestors did
  // before it branched off (path B is A-until-the-fork plus B).
  const feed = lineageFeed(data.feed, paths, shownPath);
  const chatFeed = lineageFeed(data.chatFeed, paths, shownPath);
  // Versions and conversions are scoped by the same rule, so nothing produced on another
  // path can surface in this one's chat, details or gates.
  const versionIds = new Set(feed.filter((e) => e.kind === 'version').map((e) => String(e.data.versionId)));
  const conversions = data.conversions.filter((c) => versionIds.has(c.versionId));
  // The artifact of each kind that is live. A card that is not one of these is a record of
  // something that has since been replaced, and renders as a single collapsed line.
  const extractionEntries = feed.filter((e) => e.kind === 'extraction');
  const versionEntries = feed.filter((e) => e.kind === 'version');
  const currentVersionId = String(
    versionEntries.find((e) => (e.data as { isFinal?: boolean }).isFinal)?.data.versionId ||
      versionEntries[versionEntries.length - 1]?.data.versionId ||
      '',
  );
  const current = {
    extractionId: String(extractionEntries[extractionEntries.length - 1]?.data.extractionId || ''),
    versionId: currentVersionId,
    // The PDF that belongs to the document in force — any other is a record of a version
    // that has since been replaced.
    conversionId: String(
      feed.find((e) => e.kind === 'conversion' && e.data.versionId === currentVersionId)?.data.conversionId || '',
    ),
  };
  const pendingDocs = documents.filter((d) => d.role === 'related' && d.status === 'pending');
  const acceptedItems = items.filter((i) => i.accepted);
  const chat = workflow.surfaces.chat;
  const pageHelpContext = panelStack[0]?.mode === 'items'
    ? analysis.type === 'revision' ? 'analysis.extraction.revision' : 'analysis.extraction.summary'
    : tab === 'detalhes' ? 'analysis.details' : tab === 'historico' ? 'analysis.history' : workflow.nextTask.helpContext;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={`${ANALYSIS_TYPE_LABELS[analysis.type]} — ${analysis.mainDocumentName}`}
        description={analysis.stateDetail || undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ContextHelpLink context={pageHelpContext} label="Ajuda desta página" />
            {paths.length > 1 ? (
              <span
                className={`${toneOf(shownPath)} whitespace-nowrap rounded-md px-2.5 py-1 text-sm`}
                title={shownPath === activePath ? 'A tentativa em que está a trabalhar' : 'Está a consultar uma tentativa anterior; as ações continuam bloqueadas aqui.'}
              >
                ⑂ {shownPathInfo ? pathDisplayName(shownPathInfo) : 'Percurso principal'}
                {shownPath === activePath ? '' : ` (a consultar; em uso: ${activePathInfo ? pathDisplayName(activePathInfo) : 'percurso principal'})`}
              </span>
            ) : null}
            {analysis.potentiallyAffected ? (
              <span
                className="ui-pill-warn cursor-help whitespace-nowrap rounded-md px-2.5 py-1 text-sm"
                title={analysis.affectedReason}
              >
                ⚠ Rever fontes
              </span>
            ) : null}
            <span className="ui-pill-info whitespace-nowrap rounded-md px-2.5 py-1 text-sm">
              {workflow.stateLabel}
            </span>
            <Link href="/" className="ui-btn-secondary rounded-md px-3.5 py-1.5 text-base no-underline">
              ← Processos
            </Link>
          </div>
        }
      />

      {workflow.phases.length ? <PhaseStepper phases={workflow.phases} /> : null}

      <AnalysisTabs tab={tab} onSelect={(key) => { setTab(key); setPanelStack([]); }} />

      {notice ? <p className="mb-3 text-base text-danger">{notice}</p> : null}

      <div className="grid min-h-0 flex-1 gap-5 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          {tab === 'detalhes' ? (
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="grid content-start gap-5">
            <DetalhesTab
              stateLabel={workflow.stateLabel}
              analysis={analysis}
              documents={documents}
              items={items}
              versions={feed.filter((e) => e.kind === 'version').map((e) => e.data as never)}
              conversions={conversions}
              paths={paths}
              activePath={activePath}
              draft={data.draft}
              onOpen={replacePanel}
            />
            </div>
            </div>
          ) : tab === 'chat' ? (
            <div className="ui-panel flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl">
              <div className="min-h-0 flex-1 overflow-y-auto p-5">
                <div className="grid gap-3">
                  {chatFeed.map((entry, i) => (
                    <FeedBubble
                      key={i}
                      entry={entry}
                      analysisType={analysis.type}
                      analysisId={analysisId}
                      writes={workflow.writes}
                      current={current}
                      surfaces={workflow.surfaces}
                      busy={busy}
                      onOpen={pushPanel}
                      onAct={act}
                      onDownload={actDownload}
                      onDecideTurn={(turnId, decision) => patch(`/api/analyses/${analysisId}/chat/${turnId}`, { decision })}
                    />
                  ))}
                  <PhaseGate
                    workflow={workflow}
                    analysisId={analysisId}
                    pendingDocs={pendingDocs}
                    busy={busy}
                    onAct={act}
                    onDownload={actDownload}
                    onOpen={pushPanel}
                    onDecideDocument={(documentId, status) =>
                      patch(`/api/analyses/${analysisId}/documents/${documentId}`, { status })
                    }
                  />
                  {workflow.notices.map((notice) => (
                    <div
                      key={notice.id}
                      className={`mr-12 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-2.5 text-sm ${
                        notice.severity === 'error'
                          ? 'border-danger text-danger'
                          : notice.severity === 'warning'
                            ? 'ui-pill-warn border-transparent'
                            : 'border-dashed border-line1 ui-text-muted'
                      }`}
                    >
                      <span className="min-w-0">{notice.message}</span>
                      {notice.dismissPath ? (
                        <button
                          type="button"
                          onClick={() => act('Dispensar aviso', notice.dismissPath as string, { method: 'DELETE' })}
                          className="ui-btn-secondary shrink-0 rounded-md px-2.5 py-1 text-sm"
                        >
                          Já revi — dispensar
                        </button>
                      ) : null}
                    </div>
                  ))}
                  <div ref={feedEndRef} />
                </div>
              </div>
              <div className="border-t border-line0 p-3">
                {chat.enabled ? (
                  <div className="flex gap-2">
                    <input
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          void sendChat();
                        }
                      }}
                      placeholder='Pede alterações ao documento — ex.: "Simplifica a secção 2"…'
                      className="ui-input flex-1 rounded-md px-3.5 py-2.5"
                    />
                    <button
                      type="button"
                      disabled={busy !== '' || !chatInput.trim()}
                      onClick={sendChat}
                      className="ui-btn-primary rounded-md px-4 py-2 text-base"
                    >
                      {busy === 'chat' ? 'A rever…' : 'Enviar'}
                    </button>
                  </div>
                ) : (
                  <p className="m-0 px-1 text-sm ui-text-muted">{chat.disabledReason}</p>
                )}
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <HistoricoTab
              feed={data.feed}
              analysisType={analysis.type}
              paths={paths}
              stages={stages}
              activePath={activePath}
              viewingPath={shownPath}
              selectedNodeId={panel?.mode === 'node' ? panel.node.id : null}
              onSelectNode={(node) => replacePanel({ mode: 'node', node })}
              onViewPath={(letter) => setViewingPath(letter)}
              onActivatePath={(letter) => act('Usar esta tentativa', `/api/analyses/${analysisId}/paths/${letter}/activate`)}
            />
            </div>
          )}
        </div>

        {panel ? (
          <SidePanel
            panel={panel}
            depth={panelStack.length}
            analysisId={analysisId}
            path={shownPath}
            items={acceptedItems}
            canDecideItems={analysis.state === 'pronta_para_revisao' || analysis.state === 'aprovada'}
            stages={stages}
            data={data}
            busy={busy}
            onDecideItem={(itemId, decision) => patch(`/api/analyses/${analysisId}/items/${itemId}`, { decision })}
            onOpen={pushPanel}
            onBack={popPanel}
            onClose={() => setPanelStack([])}
            onRefresh={refresh}
            onTrackBack={trackBack}
            onAct={act}
          />
        ) : null}
      </div>
    </div>
  );
}

// --- citation chip: anything citable opens the source at the right page ---------------

export function CitationChip({
  documentId,
  documentName,
  page,
  excerpt,
  onOpen,
}: {
  documentId: string;
  documentName?: string;
  page: number;
  excerpt?: string;
  onOpen: (panel: Panel) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen({ mode: 'document', documentId, page, excerpt })}
      className="ui-pill-info inline-flex max-w-full items-center gap-1 truncate rounded-md px-1.5 py-0.5 font-mono text-xs hover:bg-accent-soft"
      title={excerpt ? `“${excerpt.slice(0, 200)}”` : undefined}
    >
      {documentName ? `${documentName.replace(/\.pdf$/i, '').slice(0, 24)} · ` : ''}p.{page}
    </button>
  );
}

// --- feed bubbles ----------------------------------------------------------------------

/**
 * One bubble of the chat.
 *
 * Every ARTIFACT the workflow produces — the extraction, the Word document, the final PDF,
 * the e-mail — is a card of its own, in the position where it happened, carrying the
 * actions for that artifact. The PDF used to be grafted inside the Word card and the
 * e-mail was appended outside the feed entirely, so neither appeared where it belonged and
 * neither could be opened once its phase had passed.
 *
 * Superseded artifacts collapse to one line: the log stays complete without burying the
 * one that is actually live.
 */
export function FeedBubble({
  entry,
  analysisType,
  analysisId,
  writes,
  current,
  surfaces,
  busy,
  onOpen,
  onAct,
  onDownload,
  onDecideTurn,
  tutorialTarget,
  tutorialOpenTarget,
}: {
  entry: FeedEntry;
  analysisType: AnalysisType;
  analysisId: string;
  /** One statement of whether anything may be changed right now, and why not. */
  writes: WorkflowStatus['writes'];
  /** The artifact of each kind that is in force — everything else is superseded. */
  current: { extractionId: string; versionId: string; conversionId: string };
  /** The approvals that belong to a card, resolved by the server. */
  surfaces: WorkflowStatus['surfaces'];
  busy: string;
  onOpen: (panel: Panel) => void;
  onAct: (label: string, path: string) => void;
  onDownload: (label: string, path: string) => void;
  onDecideTurn: (turnId: string, decision: 'confirm' | 'discard') => void;
  tutorialTarget?: string;
  tutorialOpenTarget?: string;
}) {
  const time = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (entry.kind === 'user_said') {
    return <UserBubble time={time}>{String(entry.data.text || '')}</UserBubble>;
  }

  if (entry.kind.startsWith('event:')) {
    const kind = entry.kind.slice(6);
    const sentence = eventChatSentence(kind, entry.data, analysisType);
    if (!sentence) return null;
    return eventVoice(kind) === 'user' ? (
      <UserBubble time={time}>{sentence}</UserBubble>
    ) : (
      <AssistantBubble time={time}>{sentence}</AssistantBubble>
    );
  }

  if (entry.kind === 'extraction') {
    const e = entry.data as {
      extractionId: string;
      label: string;
      origin: string;
      acceptedCount: number;
      rejectedCount: number;
      approvedAt: number | null;
      note: string;
    };
    const isCurrent = e.extractionId === current.extractionId;
    return (
      <ArtifactCard
        icon="◧"
        title={msg('card.extraction.title')}
        subtitle={msg('card.extraction.counts', { accepted: e.acceptedCount, rejected: e.rejectedCount })}
        note={e.note}
        pill={e.approvedAt ? { tone: 'ui-pill-ok', text: msg('card.extraction.approved') } : null}
        superseded={!isCurrent}
        supersededText={msg('card.extraction.superseded', { by: 'uma extração mais recente' })}
      >
        <button type="button" data-tutorial-target={tutorialTarget} onClick={() => onOpen({ mode: 'items' })} className="ui-link text-sm">
          {msg('card.extraction.open')}
        </button>
      </ArtifactCard>
    );
  }

  if (entry.kind === 'version') {
    const v = entry.data as {
      versionId: string;
      label: string;
      filename: string;
      origin: string;
      note: string;
      isFinal: boolean;
    };
    const isCurrent = v.versionId === current.versionId;
    return (
      <ArtifactCard
        icon="⧉"
        title={msg('card.document.title')}
        chip={<VersionChip label={v.label} />}
        subtitle={v.filename}
        mono
        note={v.note}
        pill={v.isFinal ? { tone: 'ui-pill-ok', text: 'Aprovado' } : { tone: 'ui-pill-info', text: 'Rascunho' }}
        superseded={!isCurrent && !v.isFinal}
        supersededText={msg('card.document.superseded', { by: 'uma versão mais recente' })}
      >
        <button type="button" data-tutorial-target={tutorialOpenTarget} onClick={() => onOpen({ mode: 'version', versionId: v.versionId })} className="ui-link text-sm">
          Pré-visualizar
        </button>
        <button type="button" onClick={() => onOpen({ mode: 'edit', versionId: v.versionId })} className="ui-link text-sm">
          Editar
        </button>
        <a href={`/api/analyses/${analysisId}/versions/${v.versionId}/download`} className="ui-link text-sm">
          Descarregar
        </a>
        {!v.isFinal && isCurrent ? (
          <button
            type="button"
            disabled={busy !== '' || !writes.allowed || !surfaces.setFinal.enabled}
            title={writes.reason || surfaces.setFinal.disabledReason || undefined}
            data-tutorial-target={tutorialTarget}
            onClick={() => onAct(surfaces.setFinal.label, `/api/analyses/${analysisId}/versions/${v.versionId}/final`)}
            className="ui-btn-primary rounded-md px-3 py-1 text-sm disabled:opacity-50"
          >
            {surfaces.setFinal.label}
          </button>
        ) : null}
      </ArtifactCard>
    );
  }

  if (entry.kind === 'conversion') {
    const c = entry.data as unknown as Conversion;
    const tone = CONV_TONES[c.state];
    const label = CONVERSION_STATE_LABELS[c.state];
    const isCurrent = c.conversionId === current.conversionId;
    const size = c.pdfSize ? `${Math.round(c.pdfSize / 1024)} KB` : '';
    return (
      <ArtifactCard
        icon="▤"
        title={msg('card.pdf.title')}
        subtitle={c.pdfFilename || ''}
        mono
        note={c.stateDetail}
        pill={{ tone, text: label }}
        superseded={!isCurrent && c.state === 'desatualizado'}
        supersededText={msg('card.pdf.superseded')}
        meta={c.pdfPages ? msg('card.pdf.meta', { pages: c.pdfPages, size }) : ''}
      >
        {c.pdfFilename ? (
          <button
            type="button"
            data-tutorial-target={tutorialOpenTarget}
            onClick={() =>
              onOpen({ mode: 'pdf', url: `/api/analyses/${analysisId}/conversions/${c.conversionId}/pdf`, title: c.pdfFilename })
            }
            className="ui-link text-sm"
          >
            {msg('card.pdf.open')}
          </button>
        ) : null}
        {c.jsonFilename ? (
          <a
            href={`/api/analyses/${analysisId}/conversions/${c.conversionId}/json`}
            className="ui-link text-sm no-underline"
          >
            {msg('card.pdf.data')}
          </a>
        ) : null}
        {c.state === 'pronto_para_revisao' ? (
          <button
            type="button"
            disabled={busy !== '' || !writes.allowed || !surfaces.approvePdf.enabled}
            title={writes.reason || surfaces.approvePdf.disabledReason || undefined}
            data-tutorial-target={tutorialTarget}
            onClick={() => onAct(surfaces.approvePdf.label, `/api/analyses/${analysisId}/conversions/${c.conversionId}/approve`)}
            className="ui-btn-primary rounded-md px-3 py-1 text-sm disabled:opacity-50"
          >
            {surfaces.approvePdf.label}
          </button>
        ) : null}
        {c.state === 'erro' ? (
          <button
            type="button"
            disabled={busy !== '' || !writes.allowed}
            title={writes.reason || undefined}
            onClick={() => onAct('Repetir conversão', `/api/analyses/${analysisId}/conversions/${c.conversionId}/retry`)}
            className="ui-btn-secondary rounded-md px-3 py-1 text-sm disabled:opacity-50"
          >
            Repetir conversão
          </button>
        ) : null}
      </ArtifactCard>
    );
  }

  if (entry.kind === 'email') {
    const e = entry.data as {
      to: string;
      cc: string;
      subject: string;
      body: string;
      attachment: { pdfName: string; pdfSize: number } | null;
      approved?: boolean;
    };
    return (
      <ArtifactCard
        icon="✉"
        title={msg('card.email.title')}
        subtitle={e.subject}
        pill={e.approved ? { tone: 'ui-pill-ok', text: 'Aprovado' } : { tone: 'ui-pill-info', text: 'Rascunho' }}
      >
        <div className="w-full">
          <div className="ui-soft-panel mb-2 rounded-md p-3 text-sm">
            <p className="m-0">
              <span className="ui-text-muted">Para </span>
              {e.to || <span className="ui-text-subtle">(por preencher)</span>}
            </p>
            <p className="m-0 mt-2 whitespace-pre-wrap border-t border-line0 pt-2">{e.body}</p>
            {e.attachment ? (
              <p className="m-0 mt-2 border-t border-line0 pt-2 font-mono text-xs">
                📎 {e.attachment.pdfName} ({Math.round(e.attachment.pdfSize / 1024)} KB)
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" data-tutorial-target={tutorialOpenTarget} onClick={() => onOpen({ mode: 'email' })} className="ui-link text-sm">
              {e.approved ? 'Consultar e-mail' : msg('card.email.open')}
            </button>
            {e.attachment && !e.approved ? (
              <button
                type="button"
                disabled={busy !== '' || !writes.allowed || !surfaces.approveEmail.enabled}
                title={writes.reason || surfaces.approveEmail.disabledReason || undefined}
                data-tutorial-target={tutorialTarget}
                onClick={() => onAct(surfaces.approveEmail.label, surfaces.approveEmail.path)}
                className="ui-btn-primary rounded-md px-3 py-1 text-sm disabled:opacity-50"
              >
                {surfaces.approveEmail.label}
              </button>
            ) : null}
            {e.attachment && e.approved ? (
              <button
                type="button"
                disabled={busy !== ''}
                data-tutorial-target={tutorialTarget}
                onClick={() => onDownload('Descarregar rascunho', `/api/analyses/${analysisId}/email-draft/download`)}
                className="ui-btn-primary rounded-md px-3 py-1 text-sm disabled:opacity-50"
              >
                Descarregar rascunho (.eml)
              </button>
            ) : null}
          </div>
        </div>
      </ArtifactCard>
    );
  }

  if (entry.kind === 'turn') {
    const t = entry.data as {
      turnId: string;
      userMessage: string;
      reply: string;
      status: string;
      impact: { reasons?: string[]; appOverrode?: boolean };
    };
    return (
      <div className="grid gap-3">
        <UserBubble time={time}>{t.userMessage}</UserBubble>
        <div className={`ui-soft-panel ml-[38px] max-w-[80%] rounded-lg rounded-tl-none p-3.5 ${t.status === 'discarded' ? 'opacity-60' : ''}`}>
          <p className="m-0 text-base">{t.reply}</p>
          {(t.impact.reasons || []).map((reason, i) => (
            <p key={i} className={`m-0 mt-1 text-sm ${t.impact.appOverrode ? 'text-warn' : 'ui-text-muted'}`}>
              {reason}
            </p>
          ))}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {t.status === 'pending_confirmation' ? (
              <>
                <span className="ui-pill-warn rounded-md px-2 py-0.5 text-sm">Exige confirmação</span>
                <button
                  type="button"
                  disabled={busy !== ''}
                  data-tutorial-target={tutorialTarget}
                  onClick={() => onDecideTurn(t.turnId, 'confirm')}
                  className="ui-btn-primary rounded-md px-3 py-1 text-sm"
                >
                  Confirmar alteração
                </button>
                <button
                  type="button"
                  disabled={busy !== ''}
                  onClick={() => onDecideTurn(t.turnId, 'discard')}
                  className="ui-btn-secondary rounded-md px-3 py-1 text-sm"
                >
                  Descartar
                </button>
              </>
            ) : t.status === 'applied' ? (
              <span className="ui-pill-ok rounded-md px-2 py-0.5 text-sm">Aplicada — nova versão</span>
            ) : (
              <span className="ui-pill-info rounded-md px-2 py-0.5 text-sm">Descartada</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}

function PhaseGate(props: {
  workflow: WorkflowStatus;
  analysisId: string;
  pendingDocs: AnalysisDocument[];
  busy: string;
  onAct: (label: string, path: string) => void;
  onDownload: (label: string, path: string) => void;
  onOpen: (panel: Panel) => void;
  onDecideDocument: (documentId: string, status: 'confirmed' | 'excluded') => void;
}) {
  const { workflow, pendingDocs, busy, onAct, onDownload, onOpen, onDecideDocument } = props;

  if (workflow.progress) {
    return (
      <div className="ui-panel mr-12 flex items-center gap-3 rounded-lg border border-accent-ghost p-3.5">
        <span className="flex gap-1" aria-hidden>
          <span className="h-2 w-2 animate-bounce rounded-full bg-accent [animation-delay:0ms]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-accent [animation-delay:150ms]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-accent [animation-delay:300ms]" />
        </span>
        <p className="m-0 text-base">{workflow.phase.headline}</p>
      </div>
    );
  }

  if (workflow.closed) return null;

  const failed = workflow.failure;
  return (
    <ActionBubble tone={failed ? 'danger' : 'accent'}>
      <div className="grid gap-2.5">
        <p className="m-0 text-base">{workflow.phase.headline}</p>

        {pendingDocs.length > 0 ? (
          <div className="grid gap-2">
            {pendingDocs.map((doc) => (
              <div key={doc.documentId} className="grid gap-1.5 rounded-md border border-hair p-2.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="text-base">
                  <button type="button" onClick={() => onOpen({ mode: 'document', documentId: doc.documentId })} className="ui-link">
                    {doc.documentName}
                  </button>
                  {relatedDocumentRelationLabel(doc.relationType) ? (
                    <span className="ui-text-muted"> — {relatedDocumentRelationLabel(doc.relationType)}</span>
                  ) : null}
                  {doc.versionLabel || doc.issuedDate ? (
                    <span className="ui-text-muted">
                      {' '}
                      · {[doc.versionLabel, doc.issuedDate].filter(Boolean).join(' · ')}
                    </span>
                  ) : null}
                  {doc.relevance ? (
                    <span
                      className={`ml-2 rounded px-1.5 py-0.5 text-xs ${
                        doc.relevance === 'alta' ? 'ui-pill-warn' : 'ui-pill-info'
                      }`}
                    >
                      {RELEVANCE_LABELS[doc.relevance]}
                    </span>
                  ) : null}
                  <ConfidencePill confidence={doc.confidence} className="ml-2" small />
                </span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => onDecideDocument(doc.documentId, 'confirmed')}
                    className="ui-btn-primary rounded-md px-3 py-1 text-sm"
                  >
                    Confirmar
                  </button>
                  <button
                    type="button"
                    onClick={() => onDecideDocument(doc.documentId, 'excluded')}
                    className="ui-btn-secondary rounded-md px-3 py-1 text-sm"
                  >
                    Excluir
                  </button>
                </span>
                </div>
                {doc.confidence?.basis ? (
                  <p className="ui-text-muted m-0 text-sm">{doc.confidence.basis}</p>
                ) : null}
                {doc.reason ? <p className="ui-text-muted m-0 text-sm">{doc.reason}</p> : null}
                {doc.excerpts.map((excerpt, i) => (
                  <p key={i} className="ui-soft-panel m-0 rounded px-2 py-1 text-sm">
                    <span className="ui-text-muted">
                      {excerpt.page > 0 ? `pág. ${excerpt.page}` : 'referência'} ·{' '}
                    </span>
                    «{excerpt.text}»
                  </p>
                ))}
              </div>
            ))}
          </div>
        ) : null}

        {workflow.blockers.map((blocker) => (
          <p key={blocker.id} className="ui-pill-warn m-0 rounded-md px-2.5 py-1 text-sm">
            🔒 {blocker.message}
          </p>
        ))}

        {workflow.actions.length ? (
          <div className="flex flex-wrap items-center gap-2">
            {workflow.actions.map((action) => (
              <button
                key={action.id}
                type="button"
                disabled={!action.enabled || busy !== ''}
                title={action.disabledReason}
                onClick={() => {
                  if (action.confirm && !window.confirm(action.confirm)) return;
                  if (action.download) onDownload(action.label, action.path);
                  else onAct(action.label, action.path);
                }}
                className={`${action.kind === 'primary' ? 'ui-btn-primary' : 'ui-btn-secondary'} rounded-md px-3.5 py-1.5 text-base disabled:opacity-50`}
              >
                {busy === action.label && action.busyLabel ? action.busyLabel : action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </ActionBubble>
  );
}

function ArtifactCard({
  icon,
  title,
  chip,
  subtitle,
  meta,
  note,
  pill,
  mono,
  superseded,
  supersededText,
  children,
}: {
  icon: string;
  title: string;
  chip?: React.ReactNode;
  subtitle?: string;
  meta?: string;
  note?: string;
  pill?: { tone: string; text: string } | null;
  mono?: boolean;
  superseded?: boolean;
  supersededText?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (superseded && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mr-12 flex w-full items-center gap-2 rounded-lg border border-dashed border-line1 px-3 py-1.5 text-left text-sm ui-text-muted hover:border-accent"
      >
        <span aria-hidden>{icon}</span>
        <span className="truncate">
          {title}
          {subtitle ? ` · ${subtitle}` : ''}
        </span>
        <span className="ml-auto shrink-0 text-xs ui-text-subtle">{supersededText} ▸</span>
      </button>
    );
  }
  return (
    <div className={`ui-soft-panel mr-12 rounded-lg p-3.5 ${superseded ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="m-0 flex min-w-0 flex-wrap items-center gap-2 text-base">
          <span aria-hidden className="ui-text-subtle">
            {icon}
          </span>
          <span className="font-medium text-ink0">{title}</span>
          {chip}
          {subtitle ? (
            <span className={`min-w-0 break-all ${mono ? 'font-mono text-sm' : 'text-sm ui-text-muted'}`}>{subtitle}</span>
          ) : null}
          {meta ? <span className="text-sm ui-text-muted">· {meta}</span> : null}
        </p>
        {pill ? <span className={`${pill.tone} shrink-0 rounded-md px-2 py-0.5 text-sm`}>{pill.text}</span> : null}
      </div>
      {note ? <p className="mt-1 mb-0 text-sm ui-text-muted">{note}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

function ActionBubble({ children, tone = 'accent' }: { children: React.ReactNode; tone?: 'accent' | 'danger' }) {
  return (
    <div className="flex gap-2.5">
      <Avatar />
      <div
        className={`ui-panel min-w-0 flex-1 rounded-lg rounded-tl-none border p-3.5 ${
          tone === 'danger' ? 'border-danger' : 'border-accent-ghost'
        }`}
      >
        {children}
      </div>
    </div>
  );
}

function Avatar() {
  return (
    <span
      aria-hidden
      className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm text-accent-strong"
    >
      ⚖
    </span>
  );
}

function UserBubble({ children, time }: { children: React.ReactNode; time?: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-lg rounded-br-none bg-surface-user p-3">
        <p className="m-0 text-base">{children}</p>
        {time ? <p className="mt-1 mb-0 text-right font-mono text-xs ui-text-subtle">{time}</p> : null}
      </div>
    </div>
  );
}

function AssistantBubble({ children, time }: { children: React.ReactNode; time?: string }) {
  return (
    <div className="flex gap-2.5">
      <Avatar />
      <div className="ui-soft-panel min-w-0 max-w-[80%] rounded-lg rounded-tl-none p-3">
        <p className="m-0 text-base">{children}</p>
        {time ? <p className="mt-1 mb-0 font-mono text-xs ui-text-subtle">{time}</p> : null}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="ui-text-muted">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </>
  );
}

export function DetalhesTab({
  stateLabel,
  analysis,
  documents,
  items,
  versions,
  conversions,
  paths,
  activePath,
  draft,
  onOpen,
  tutorialTarget,
}: {
  stateLabel: string;
  analysis: Analysis;
  documents: AnalysisDocument[];
  items: Item[];
  versions: Array<{ versionId: string; label: string; isFinal: boolean; origin: string; templateId: string; templateVersion: number }>;
  conversions: Conversion[];
  paths: PathInfo[];
  activePath: string;
  draft: Timeline['draft'];
  onOpen: (panel: Panel) => void;
  tutorialTarget?: string;
}) {
  const main = documents.find((d) => d.role === 'main');
  const related = documents.filter((d) => d.role === 'related');
  const accepted = items.filter((i) => i.accepted);
  const rejected = items.filter((i) => !i.accepted);
  const suggestions = accepted.filter((i) => i.payload.ai_suggestion === true);
  const finalVersion = versions.find((v) => v.isFinal);
  const latestVersion = versions.at(-1);
  const lastConversion = conversions[0];
  const activePathInfo = paths.find((path) => path.letter === activePath);

  return (
    <div data-tutorial-target={tutorialTarget} className="grid gap-5">
      <div className="ui-panel rounded-xl p-5">
        <h2 className="m-0 mb-4 text-xl font-semibold text-ink0">Configuração</h2>
        <dl className="m-0 grid grid-cols-[10rem_1fr] gap-x-6 gap-y-2 text-base">
          <Row label="Fluxo">{ANALYSIS_TYPE_LABELS[analysis.type]}</Row>
          <Row label="Documento principal">
            <button
              type="button"
              onClick={() => onOpen({ mode: 'document', documentId: analysis.mainDocumentId })}
              className="ui-link text-left"
            >
              {main?.documentName || analysis.mainDocumentName}
            </button>
          </Row>
          <Row label="Documentos relacionados">
            {related.length === 0 ? (
              <span className="ui-text-muted">Nenhum</span>
            ) : (
              <ul className="m-0 grid list-none gap-1 p-0">
                {related.map((doc) => (
                  <li key={doc.documentId}>
                    <span
                      className={`${doc.status === 'confirmed' ? 'ui-pill-ok' : doc.status === 'excluded' ? 'ui-pill-warn' : 'ui-pill-info'} mr-2 rounded-md px-2 py-0.5 text-sm`}
                    >
                      {doc.status === 'confirmed' ? 'confirmado' : doc.status === 'excluded' ? 'excluído' : 'por decidir'}
                    </span>
                    <ConfidencePill confidence={doc.confidence} className="mr-2" />
                    <button
                      type="button"
                      onClick={() => onOpen({ mode: 'document', documentId: doc.documentId })}
                      className="ui-link"
                    >
                      {doc.documentName}
                    </button>
                    {relatedDocumentRelationLabel(doc.relationType) ? (
                      <span className="ui-text-muted"> — {relatedDocumentRelationLabel(doc.relationType)}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Row>
          <Row label="Instruções">
            {analysis.instructions ? (
              <span className="whitespace-pre-wrap">{analysis.instructions}</span>
            ) : (
              <span className="ui-text-muted">Nenhuma</span>
            )}
          </Row>
          <Row label="Template">
            {versions.find((v) => v.templateId) ? (
              <span className="font-mono text-sm">
                {versions.find((v) => v.templateId)?.templateId} v{versions.find((v) => v.templateId)?.templateVersion}
              </span>
            ) : (
              <span className="ui-text-muted">Standard do fluxo</span>
            )}
          </Row>
        </dl>
      </div>

      <div className="ui-panel rounded-xl p-5">
        <h2 className="m-0 mb-4 text-xl font-semibold text-ink0">Estado atual</h2>
        <dl className="m-0 grid grid-cols-[10rem_1fr] gap-x-6 gap-y-2 text-base">
          <Row label="Fase">{stateLabel}</Row>
          <Row label="Versão em uso">
            {activePathInfo ? pathDisplayName(activePathInfo) : 'Percurso principal'}
            {paths.length > 1 ? <span className="ui-text-muted"> · {paths.length} tentativas guardadas</span> : null}
          </Row>
          <Row label="Itens validados">
            <button type="button" onClick={() => onOpen({ mode: 'items' })} className="ui-link">
              {accepted.length} item(ns)
            </button>
            {rejected.length ? (
              <span className="ui-text-muted"> · {rejected.length} rejeitado(s) pelos validadores de citações</span>
            ) : null}
            {suggestions.length ? <span className="ui-text-muted"> · {suggestions.length} sugestão(ões) da IA</span> : null}
          </Row>
          <Row label="Resultados gerados">
            {versions.length === 0 ? (
              <span className="ui-text-muted">Nenhum</span>
            ) : (
              <span>
                {versions.length} versão(ões)
                {finalVersion ? (
                  <>
                    {' '}· final:{' '}
                    <button
                      type="button"
                      onClick={() => onOpen({ mode: 'version', versionId: finalVersion.versionId })}
                      className="ui-link font-mono"
                    >
                      {finalVersion.label}
                    </button>
                  </>
                ) : null}
              </span>
            )}
          </Row>
          <Row label="PDF">
            {lastConversion ? (
              <span>
                <span className={`${CONV_TONES[lastConversion.state]} mr-2 whitespace-nowrap rounded-md px-2 py-0.5 text-sm`}>
                  {CONVERSION_STATE_LABELS[lastConversion.state]}
                </span>
                {lastConversion.pdfFilename}
              </span>
            ) : (
              <span className="ui-text-muted">Ainda não convertido</span>
            )}
          </Row>
          {analysis.potentiallyAffected ? <Row label="Aviso">{analysis.affectedReason}</Row> : null}
        </dl>
      </div>

      <div className="ui-panel rounded-xl p-5">
        <div className="mb-4">
          <h2 className="m-0 text-xl font-semibold text-ink0">Resultados da análise</h2>
          <p className="mt-1 mb-0 text-sm ui-text-muted">A sequência é Word → PDF → e-mail. Cada aprovação desbloqueia o resultado seguinte.</p>
        </div>
        <OutputSequence items={[
          {
            key: 'word', title: 'Documento Word',
            status: latestVersion ? (latestVersion.isFinal ? 'Aprovado' : 'Pronto para rever') : 'Ainda não criado',
            detail: latestVersion?.label || 'É criado depois de aprovar os resultados encontrados.',
            action: latestVersion ? <button type="button" onClick={() => onOpen({ mode: 'version', versionId: latestVersion.versionId })} className="ui-link w-fit text-sm">Abrir</button> : undefined,
          },
          {
            key: 'pdf', title: 'PDF final',
            status: lastConversion ? CONVERSION_STATE_LABELS[lastConversion.state] : 'Ainda não criado',
            detail: lastConversion?.pdfFilename || 'É criado depois de aprovar o documento Word.',
            action: lastConversion?.pdfFilename ? <button type="button" onClick={() => onOpen({ mode: 'pdf', url: `/api/analyses/${analysis.analysisId}/conversions/${lastConversion.conversionId}/pdf`, title: lastConversion.pdfFilename })} className="ui-link w-fit text-sm">Abrir</button> : undefined,
          },
          {
            key: 'email', title: 'E-mail',
            status: draft.allowed ? 'Pronto para preparar' : 'Ainda não disponível',
            detail: draft.allowed ? `Com ${draft.summary.pdfName} em anexo.` : draft.reason,
            action: draft.allowed ? <button type="button" onClick={() => onOpen({ mode: 'email' })} className="ui-link w-fit text-sm">Abrir</button> : undefined,
          },
        ]} />
      </div>
    </div>
  );
}

export function HistoricoTab({
  feed,
  analysisType,
  paths,
  stages,
  activePath,
  viewingPath,
  selectedNodeId,
  onSelectNode,
  onViewPath,
  onActivatePath,
  tutorialTarget,
  tutorialNodeTarget,
  tutorialNodeStage,
  tutorialPathTarget,
  tutorialPathLetter,
  tutorialActivatePathTarget,
}: {
  feed: FeedEntry[];
  analysisType: AnalysisType;
  paths: PathInfo[];
  stages: StageDef[];
  activePath: string;
  viewingPath: string;
  selectedNodeId: string | null;
  onSelectNode: (node: GraphNode) => void;
  onViewPath: (letter: string) => void;
  onActivatePath: (letter: string) => void;
  tutorialTarget?: string;
  tutorialNodeTarget?: string;
  tutorialNodeStage?: string;
  tutorialPathTarget?: string;
  tutorialPathLetter?: string;
  tutorialActivatePathTarget?: string;
}) {
  return (
    <div data-tutorial-target={tutorialTarget} className="ui-panel flex max-h-full flex-col overflow-hidden rounded-xl">
      <div className="shrink-0 px-5 pb-3 pt-5">
        <h2 className="m-0 mb-1.5 text-xl font-semibold text-ink0">{VERSION_LANGUAGE.section}</h2>
        <p className="m-0 text-sm ui-text-muted">
          O percurso principal e cada nova tentativa ficam guardados. Os nomes explicam a causa da alternativa;
          abra um passo para consultar os detalhes ou recomeçar a partir desse momento.
        </p>
      </div>
      <div className="min-h-[5rem] flex-1 overflow-auto px-5 pb-5">
      {viewingPath !== activePath ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent bg-accent-ghost px-4 py-3">
          <p className="m-0 text-sm">Está a consultar <strong>{pathDisplayName(paths.find((path) => path.letter === viewingPath) || { letter: viewingPath, parentVersionId: '', parentLabel: '', parentStage: '' })}</strong>. A tentativa em uso não muda só por a consultar.</p>
          <button type="button" data-tutorial-target={tutorialActivatePathTarget} onClick={() => onActivatePath(viewingPath)} className="ui-btn-primary rounded-md px-3 py-1.5 text-sm">Passar a trabalhar nesta tentativa</button>
        </div>
      ) : null}
      {stages.length === 0 ? null : (
        <WorkflowGraph
          feed={feed}
          paths={paths}
          stages={stages.map((s) => ({ key: s.key, label: s.label }))}
          activePath={activePath}
          viewingPath={viewingPath}
          selectedNodeId={selectedNodeId}
          onSelect={onSelectNode}
          onViewPath={onViewPath}
          tutorialNodeTarget={tutorialNodeTarget}
          tutorialNodeStage={tutorialNodeStage}
          tutorialPathTarget={tutorialPathTarget}
          tutorialPathLetter={tutorialPathLetter}
        />
      )}
      <details className="mt-5 border-t border-line0 pt-4">
        <summary className="cursor-pointer text-sm font-medium text-ink0">Registo técnico ({feed.length} entradas)</summary>
        <p className="mt-1 mb-3 text-xs ui-text-muted">Datas, interveniente e identificadores para auditoria. Este registo não altera a versão em uso.</p>
        <div className="max-h-72 overflow-auto rounded-lg border border-line0">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 bg-bg1 text-ink1">
              <tr><th className="p-2">Data</th><th className="p-2">Interveniente</th><th className="p-2">Acontecimento</th><th className="p-2">Identificador</th></tr>
            </thead>
            <tbody>
              {[...feed].reverse().map((entry, index) => (
                <tr key={`${entry.at}:${entry.kind}:${index}`} className="border-t border-line0 align-top">
                  <td className="whitespace-nowrap p-2">{new Date(entry.at).toLocaleString('pt-PT')}</td>
                  <td className="p-2">{auditActor(entry)}</td>
                  <td className="p-2">{auditLabel(entry, analysisType)}</td>
                  <td className="p-2 font-mono ui-text-muted">{auditIdentifier(entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      </div>
    </div>
  );
}

function auditActor(entry: FeedEntry): string {
  if (entry.kind === 'user_said' || entry.kind === 'turn') return 'Utilizador';
  if (entry.kind.startsWith('event:') && eventVoice(entry.kind.slice(6)) === 'user') return 'Utilizador';
  return 'Aplicação';
}

function auditLabel(entry: FeedEntry, analysisType: AnalysisType): string {
  if (entry.kind.startsWith('event:')) return eventChatSentence(entry.kind.slice(6), entry.data, analysisType) || entry.kind.slice(6);
  if (entry.kind === 'version') return `Documento ${String(entry.data.label || '')}`;
  if (entry.kind === 'extraction') return `Resultados ${String(entry.data.label || '')}`;
  if (entry.kind === 'conversion') return `PDF ${String(entry.data.state || '')}`;
  if (entry.kind === 'turn') return 'Pedido de alteração';
  return String(entry.data.text || entry.kind);
}

function auditIdentifier(entry: FeedEntry): string {
  return String(entry.data.versionId || entry.data.extractionId || entry.data.conversionId || entry.data.turnId || entry.data.eventId || '—');
}

function SidePanel({
  panel,
  depth,
  analysisId,
  path,
  items,
  canDecideItems,
  stages,
  data,
  busy,
  onDecideItem,
  onOpen,
  onBack,
  onClose,
  onRefresh,
  onTrackBack,
  onAct,
}: {
  panel: Panel;
  depth: number;
  analysisId: string;
  path: string;
  items: Item[];
  canDecideItems: boolean;
  stages: StageDef[];
  data: Timeline;
  busy: string;
  onDecideItem: (itemId: string, decision: 'accepted' | 'rejected') => void;
  onOpen: (panel: Panel) => void;
  onBack: () => void;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onTrackBack: (stage: { key: string; restart: string }, guidance: string) => Promise<void>;
  onAct: (label: string, path: string) => Promise<void>;
}) {
  const dismissible = panel.mode !== 'edit' && panel.mode !== 'email';
  return (
    <SlideOver
      open
      onClose={onClose}
      dismissible={dismissible}
      title={panel.mode === 'pdf' || panel.mode === 'docx' ? panel.title : PANEL_TITLES[panel.mode]}
      leading={
        depth > 1 ? (
          <button type="button" onClick={onBack} className="ui-btn-secondary rounded-md px-2.5 py-1 text-sm">
            ← Voltar
          </button>
        ) : null
      }
      actions={
        panel.mode === 'version' ? (
          <a
            href={`/api/analyses/${analysisId}/versions/${panel.versionId}/download`}
            className="ui-btn-secondary rounded-md px-3 py-1 text-sm no-underline"
          >
            Descarregar
          </a>
        ) : null
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {panel.mode === 'document' ? (
          <DocumentPreview
            documentId={panel.documentId}
            page={panel.page}
            excerpt={panel.excerpt}
            frameClassName={SLIDE_OVER_FRAME_HEIGHT}
          />
        ) : panel.mode === 'version' ? (
          <VersionPreview analysisId={analysisId} versionId={panel.versionId} onOpen={onOpen} />
        ) : panel.mode === 'docx' ? (
          <DocxPreview source={{ url: `/api/analyses/${analysisId}/versions/${panel.versionId}/download` }} />
        ) : panel.mode === 'pdf' ? (
          <iframe
            src={`${panel.url}#view=FitV&navpanes=0`}
            title={panel.title}
            className={`${SLIDE_OVER_FRAME_HEIGHT} w-full rounded-md border-0 bg-white`}
          />
        ) : panel.mode === 'edit' ? (
          <SectionEditor analysisId={analysisId} versionId={panel.versionId} onSaved={onRefresh} />
        ) : panel.mode === 'email' ? (
          <EmailEditor analysisId={analysisId} onSaved={onRefresh} readOnly={data.workflow.closed} />
        ) : panel.mode === 'node' ? (
          <NodeDetails
            analysisId={analysisId}
            data={data}
            node={panel.node}
            stage={stages.find((s) => s.key === panel.node.stageKey) || null}
            stages={stages}
            busy={busy}
            onOpen={onOpen}
            onTrackBack={onTrackBack}
          />
        ) : (
          <ExtractionReview
            analysisId={analysisId}
            path={path}
            canDecide={canDecideItems}
            onOpenSource={(documentId, page, excerpt) => onOpen({ mode: 'document', documentId, page, excerpt })}
            onRefresh={onRefresh}
            approval={data.workflow.actions.find((action) => action.id === 'approve_extraction') || null}
            onApprove={async (action) => {
              await onAct(action.label, action.path);
              onClose();
            }}
            onRejected={() => {
              onClose();
              void onRefresh();
            }}
          />
        )}
      </div>
    </SlideOver>
  );
}

export function EmailEditor({ analysisId, onSaved, tutorial, readOnly = false }: { analysisId: string; onSaved: () => Promise<void>; tutorial?: { to: string; cc: string; subject: string; body: string; target?: string }; readOnly?: boolean }) {
  const [content, setContent] = useState<{ to: string; cc: string; subject: string; body: string } | null>(tutorial || null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (tutorial) return;
    void fetch(`/api/analyses/${analysisId}/email-draft/content`).then((r) => r.json()).then((d) => d.ok && setContent(d.content));
  }, [analysisId, tutorial]);

  if (!content) return <p className="m-0 text-base ui-text-muted">A carregar…</p>;
  const field = (key: 'to' | 'cc' | 'subject', label: string) => (
    <label className="grid gap-1">
      <span className="text-sm ui-text-muted">{label}</span>
      <input
        value={content[key]}
        readOnly={readOnly}
        onChange={(e) => {
          setContent({ ...content, [key]: e.target.value });
          setSaved(false);
        }}
        className="ui-input rounded-md px-3 py-2 text-sm"
      />
    </label>
  );

  return (
    <div className="grid gap-3">
      {field('to', 'Para')}
      {field('cc', 'Cc')}
      {field('subject', 'Assunto')}
      <label className="grid gap-1">
        <span className="text-sm ui-text-muted">Mensagem</span>
        <textarea
          value={content.body}
          readOnly={readOnly}
          onChange={(e) => {
            setContent({ ...content, body: e.target.value });
            setSaved(false);
          }}
          rows={12}
          className="ui-input rounded-md px-3 py-2 text-sm"
        />
      </label>
      {readOnly ? <p className="m-0 text-sm ui-text-muted">E-mail aprovado. Pode consultá-lo aqui e descarregar o ficheiro .eml no cartão da análise.</p> : <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={saving}
          data-tutorial-target={tutorial?.target}
          onClick={async () => {
            if (tutorial) { setSaved(true); await onSaved(); return; }
            setSaving(true);
            try {
              await fetch(`/api/analyses/${analysisId}/email-draft/content`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(content),
              });
              setSaved(true);
              await onSaved();
            } finally {
              setSaving(false);
            }
          }}
          className="ui-btn-primary rounded-md px-3.5 py-1.5 text-sm"
        >
          {saving ? 'A guardar…' : 'Guardar alterações'}
        </button>
        {saved ? <span className="text-sm ui-text-muted">Guardado.</span> : null}
      </div>}
    </div>
  );
}

function SectionEditor({
  analysisId,
  versionId,
  onSaved,
}: {
  analysisId: string;
  versionId: string;
  onSaved: () => Promise<void>;
}) {
  const [sections, setSections] = useState<Array<{ heading: string; body: string }> | null>(null);
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void fetch(`/api/analyses/${analysisId}/versions/${versionId}/preview`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) return;
        setLabel(d.version.label);
        setSections(d.sections || []);
      });
  }, [analysisId, versionId]);

  if (!sections) return <p className="m-0 text-base ui-text-muted">A carregar…</p>;
  if (sections.length === 0) {
    return (
      <EmptyState
        title="Versão sem texto editável"
        description="Esta versão foi carregada manualmente — descarregue-a para a editar no Word."
      />
    );
  }

  return (
    <div className="grid gap-3">
      <p className="m-0 text-sm ui-text-muted">
        A editar a partir de <span className="font-mono">{label}</span>. Guardar cria uma versão nova — a original
        mantém-se intacta.
      </p>
      {sections.map((section, i) => (
        <div key={i} className="grid gap-1.5">
          <input
            value={section.heading}
            onChange={(e) =>
              setSections(sections.map((s, j) => (i === j ? { ...s, heading: e.target.value } : s)))
            }
            className="ui-input rounded-md px-3 py-1.5 text-sm font-semibold"
          />
          <textarea
            value={section.body}
            onChange={(e) => setSections(sections.map((s, j) => (i === j ? { ...s, body: e.target.value } : s)))}
            rows={Math.min(14, Math.max(3, Math.ceil(section.body.length / 90)))}
            className="ui-input rounded-md px-3 py-2 text-sm"
          />
        </div>
      ))}
      {error ? <p className="m-0 text-sm text-danger">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            setError('');
            try {
              const res = await fetch(`/api/analyses/${analysisId}/versions/${versionId}/edit`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sections }),
              }).then((r) => r.json());
              if (!res.ok) setError(res.error || 'Não foi possível guardar.');
              else await onSaved();
            } finally {
              setSaving(false);
            }
          }}
          className="ui-btn-primary rounded-md px-3.5 py-1.5 text-sm"
        >
          {saving ? 'A guardar…' : 'Guardar como nova versão'}
        </button>
        <button
          type="button"
          onClick={() => setSections([...sections, { heading: 'Nova secção', body: '' }])}
          className="ui-btn-secondary rounded-md px-3 py-1.5 text-sm"
        >
          + Secção
        </button>
      </div>
    </div>
  );
}

function NodeDetails({
  analysisId,
  data,
  node,
  stage,
  stages,
  busy,
  onOpen,
  onTrackBack,
}: {
  analysisId: string;
  data: Timeline;
  node: GraphNode;
  stage: StageDef | null;
  busy: string;

  stages: StageDef[];
  onOpen: (panel: Panel) => void;
  onTrackBack: (stage: { key: string; restart: string }, guidance: string) => Promise<void>;
}) {
  const [reverting, setReverting] = useState(false);
  const [guidance, setGuidance] = useState('');
  const { analysis, documents, items } = data;
  const stageIndex = stages.findIndex((s) => s.key === node.stageKey);
  const isPastPhase =
    stageIndex >= 0 && (node.pathLetter !== data.workflow.path || stageIndex < data.workflow.phase.index);
  const canRevert = Boolean(stage) && node.stageKey !== 'configuracao' && isPastPhase;

  const versions = node.entries.filter((e) => e.kind === 'version').map((e) => e.data as {
    versionId: string;
    label: string;
    filename: string;
    note: string;
    isFinal: boolean;
  });
  const conversions = node.entries.filter((e) => e.kind === 'conversion').map((e) => e.data as unknown as Conversion);
  const turns = node.entries.filter((e) => e.kind === 'turn').map((e) => e.data as {
    userMessage: string;
    reply: string;
    status: string;
    impact: { reasons?: string[] };
  });

  return (
    <div className="grid gap-3">
      <div>
        <p className="m-0 text-base font-semibold text-ink0">{node.stageLabel}</p>
        <p className="mt-0.5 mb-0 text-sm ui-text-muted">
          {pathDisplayName(data.paths.find((path) => path.letter === node.pathLetter) || { letter: node.pathLetter, parentVersionId: '', parentLabel: '', parentStage: '' })} · {new Date(node.at).toLocaleString('pt-PT')}
        </p>
      </div>

      {node.entries
        .filter((e) => e.kind === 'event:tracked_back')
        .map((e, i) => (
          <div key={i} className="rounded-lg border border-line0 bg-bg0 p-3">
            <p className="m-0 mb-1 text-xs font-medium uppercase tracking-wide ui-text-subtle">Motivo do recomeço</p>
            <p className="m-0 whitespace-pre-wrap text-sm text-ink0">
              {String(e.data.guidance || '') || 'Sem motivo registado.'}
            </p>
            <p className="mt-1.5 mb-0 text-xs ui-text-muted">
              Recomeço em {(ANALYSIS_JOURNEY_LABELS as Record<string, string>)[String(e.data.stage)] || stages.find((s) => s.key === String(e.data.stage))?.label || String(e.data.stage)} · foi guardado como uma nova tentativa.
            </p>
          </div>
        ))}

      {node.stageKey === 'configuracao' ? (
        <dl className="m-0 grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-sm">
          <Row label="Fluxo">{ANALYSIS_TYPE_LABELS[analysis.type]}</Row>
          <Row label="Documento principal">
            <button
              type="button"
              onClick={() => onOpen({ mode: 'document', documentId: analysis.mainDocumentId })}
              className="ui-link text-left"
            >
              {analysis.mainDocumentName}
            </button>
          </Row>
          <Row label="Relacionados">
            {documents.filter((d) => d.role === 'related').length === 0 ? (
              <span className="ui-text-muted">Nenhum</span>
            ) : (
              <ul className="m-0 grid list-none gap-1 p-0">
                {documents
                  .filter((d) => d.role === 'related')
                  .map((doc) => (
                    <li key={doc.documentId}>
                      <span
                        className={`${doc.status === 'confirmed' ? 'ui-pill-ok' : doc.status === 'excluded' ? 'ui-pill-warn' : 'ui-pill-info'} mr-1.5 rounded-md px-1.5 py-0.5 text-xs`}
                      >
                        {doc.status === 'confirmed' ? 'confirmado' : doc.status === 'excluded' ? 'excluído' : 'por decidir'}
                      </span>
                      <ConfidencePill confidence={doc.confidence} className="mr-1.5" small />
                      <button
                        type="button"
                        onClick={() => onOpen({ mode: 'document', documentId: doc.documentId })}
                        className="ui-link"
                      >
                        {doc.documentName}
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </Row>
          <Row label="Instruções">
            {analysis.instructions ? (
              <span className="whitespace-pre-wrap">{analysis.instructions}</span>
            ) : (
              <span className="ui-text-muted">Nenhuma</span>
            )}
          </Row>
        </dl>
      ) : null}

      {node.stageKey === 'extracao' ? (
        <div className="grid gap-2">
          <p className="m-0 text-sm ui-text-muted">
            {items.filter((i) => i.accepted).length} item(ns) validados
            {items.filter((i) => !i.accepted).length
              ? ` · ${items.filter((i) => !i.accepted).length} rejeitado(s) pelos validadores de citações`
              : ''}
          </p>
          {items.slice(0, 40).map((item) => (
            <div key={item.itemId} className={`ui-soft-panel rounded-lg p-2.5 text-sm ${item.accepted ? '' : 'opacity-70'}`}>
              {item.kind === 'statement' ? (
                <p className="m-0">
                    <span className="ui-pill-info mr-1.5 rounded-md px-1.5 py-0.5 text-xs">
                    {STATEMENT_TYPE_LABELS[item.payload.statement_type as keyof typeof STATEMENT_TYPE_LABELS] ||
                      String(item.payload.statement_type)}
                  </span>
                  {String(item.payload.content)}
                </p>
              ) : (
                <>
                  <p className="m-0 font-medium text-ink0">{String(item.payload.topic)}</p>
                  <p className="mt-0.5 mb-0 ui-text-muted">{String(item.payload.difference)}</p>
                </>
              )}
              <p className="mt-1 mb-0 flex flex-wrap items-center gap-2">
                {item.accepted && item.payload.source_document_id && Number(item.payload.source_page) > 0 ? (
                  <CitationChip
                    documentId={String(item.payload.source_document_id)}
                    page={Number(item.payload.source_page)}
                    excerpt={String(item.payload.source_excerpt || '')}
                    onOpen={onOpen}
                  />
                ) : null}
                {!item.accepted ? <span className="text-xs text-danger">{item.rejectionReason}</span> : null}
              </p>
            </div>
          ))}
          {items.length > 40 ? (
            <button type="button" onClick={() => onOpen({ mode: 'items' })} className="ui-link text-sm">
              Ver todos os {items.length} itens →
            </button>
          ) : null}
        </div>
      ) : null}

      {node.stageKey === 'revisao' ? (
        <div className="grid gap-2">
          <p className="m-0 text-sm ui-text-muted">
            {items.filter((i) => i.decision === 'accepted').length} aceite(s) ·{' '}
            {items.filter((i) => i.decision === 'rejected').length} rejeitada(s) pelo utilizador ·{' '}
            {items.filter((i) => i.accepted && i.decision === 'pending').length} por decidir
          </p>
          {turns.length === 0 ? (
            <p className="m-0 text-sm ui-text-muted">Sem pedidos de alteração nesta fase.</p>
          ) : (
            turns.map((turn, i) => (
              <div key={i} className="ui-soft-panel rounded-lg p-2.5 text-sm">
                <p className="m-0 font-medium text-ink0">“{turn.userMessage}”</p>
                <p className="mt-1 mb-0 ui-text-muted">{turn.reply}</p>
                {turn.impact?.reasons?.map((reason, j) => (
                  <p key={j} className="mt-1 mb-0 text-xs text-warn">
                    {reason}
                  </p>
                ))}
                <p className="mt-1 mb-0 text-xs ui-text-subtle">
                  {turn.status === 'applied' ? 'Aplicada' : turn.status === 'discarded' ? 'Descartada' : 'Aguardava confirmação'}
                </p>
              </div>
            ))
          )}
          <button type="button" onClick={() => onOpen({ mode: 'items' })} className="ui-link text-sm">
            Rever os itens →
          </button>
        </div>
      ) : null}

      {node.stageKey === 'documento' ? (
        <ul className="m-0 grid list-none gap-2 p-0">
          {versions.length === 0 ? <li className="text-sm ui-text-muted">Sem documento neste passo.</li> : null}
          {versions.map((v) => (
            <li key={v.versionId} className="ui-soft-panel rounded-lg p-3 text-sm">
              <p className="m-0">
                <VersionChip label={v.label} />
                <span className="ml-2 break-all font-mono text-xs">{v.filename}</span>
                {v.isFinal ? <span className="ui-pill-ok ml-2 rounded-md px-2 py-0.5 text-xs">Final</span> : null}
              </p>
              {v.note ? <p className="mt-1 mb-0 ui-text-muted">{v.note}</p> : null}
              <p className="mt-1.5 mb-0 flex flex-wrap gap-3">
                <button type="button" onClick={() => onOpen({ mode: 'version', versionId: v.versionId })} className="ui-link">
                  Pré-visualizar
                </button>
                <button type="button" onClick={() => onOpen({ mode: 'edit', versionId: v.versionId })} className="ui-link">
                  Editar
                </button>
                <a href={`/api/analyses/${analysisId}/versions/${v.versionId}/download`} className="ui-link">
                  Descarregar
                </a>
              </p>
            </li>
          ))}
        </ul>
      ) : null}

      {node.stageKey === 'pdf' ? (
        <ul className="m-0 grid list-none gap-2 p-0">
          {conversions.map((c) => (
            <li key={c.conversionId} className="ui-soft-panel rounded-lg p-3 text-sm">
              <p className="m-0">
                <span className={`${CONV_TONES[c.state]} mr-2 whitespace-nowrap rounded-md px-2 py-0.5 text-xs`}>
                  {CONVERSION_STATE_LABELS[c.state]}
                </span>
                <span className="break-all">{c.pdfFilename || 'PDF'}</span>
              </p>
              {c.pdfFilename ? (
                <p className="mt-1.5 mb-0">
                  <button
                    type="button"
                    onClick={() =>
                      onOpen({ mode: 'pdf', url: `/api/analyses/${analysisId}/conversions/${c.conversionId}/pdf`, title: c.pdfFilename })
                    }
                    className="ui-link"
                  >
                    Ver o PDF
                  </button>
                </p>
              ) : null}
              {c.stateDetail ? <p className="mt-1 mb-0 ui-text-muted">{c.stateDetail}</p> : null}
            </li>
          ))}
          {conversions.length === 0 ? <p className="m-0 text-sm ui-text-muted">Sem conversões nesta fase.</p> : null}
        </ul>
      ) : null}

      {node.stageKey === 'email' ? <EmailPhaseView analysisId={analysisId} onOpen={onOpen} /> : null}

      {canRevert && stage ? (
        <div className="border-t border-line0 pt-3">
          {!reverting ? (
            <button type="button" onClick={() => setReverting(true)} className="ui-btn-secondary rounded-md px-3.5 py-1.5 text-base">
              ↩ Recomeçar a partir desta fase
            </button>
          ) : (
            <div className="grid gap-2">
              <p className="m-0 text-sm">{stage.prompt}</p>
              <div className="rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm">
                <p className="m-0 font-medium text-ink0">O que acontece se recomeçar aqui</p>
                <p className="mt-1 mb-0 ui-text-muted">
                  As tentativas e resultados existentes ficam guardados no histórico. A aplicação cria uma nova tentativa a partir de {(ANALYSIS_JOURNEY_LABELS as Record<string, string>)[stage.key] || stage.label.toLowerCase()} e volta a pedir as decisões afetadas; nada é apagado.
                </p>
              </div>
              <textarea
                value={guidance}
                onChange={(e) => setGuidance(e.target.value)}
                rows={3}
                placeholder={stage.placeholder}
                className="ui-input w-full rounded-md px-3 py-2 text-sm"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy !== '' || !guidance.trim()}
                  onClick={async () => {
                    await onTrackBack(stage, guidance.trim());
                    setReverting(false);
                    setGuidance('');
                  }}
                  className="ui-btn-primary rounded-md px-3.5 py-1.5 text-sm disabled:opacity-40"
                >
                  {busy === 'trackback' ? 'A criar nova tentativa…' : 'Confirmar nova tentativa'}
                </button>
                <button type="button" onClick={() => setReverting(false)} className="ui-btn-secondary rounded-md px-3 py-1.5 text-sm">
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </div>
      ) : node.stageKey === 'configuracao' ? (
        <p className="m-0 border-t border-line0 pt-3 text-sm ui-text-muted">
          A configuração é o ponto de partida desta análise — para mudá-la, comece uma análise nova.
        </p>
      ) : (
        <p className="m-0 border-t border-line0 pt-3 text-sm ui-text-muted">
          Só é possível recomeçar a partir de fases anteriores à atual ({data.workflow.phase.label}).
        </p>
      )}
    </div>
  );
}

function EmailPhaseView({ analysisId, onOpen }: { analysisId: string; onOpen: (panel: Panel) => void }) {
  const [data, setData] = useState<{
    content: { to: string; cc: string; subject: string; body: string };
    attachment: { pdfName: string; pdfSize: number } | null;
    allowed: boolean;
    reason?: string;
  } | null>(null);

  useEffect(() => {
    void fetch(`/api/analyses/${analysisId}/email-draft/content`)
      .then((r) => r.json())
      .then((d) => d.ok && setData(d));
  }, [analysisId]);

  if (!data) return <p className="m-0 text-sm ui-text-muted">A carregar…</p>;
  return (
    <div className="grid gap-2">
      <div className="ui-soft-panel rounded-lg p-3">
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
          <Row label="Para">{data.content.to || <span className="ui-text-subtle">(por preencher)</span>}</Row>
          {data.content.cc ? <Row label="Cc">{data.content.cc}</Row> : null}
          <Row label="Assunto">{data.content.subject}</Row>
        </dl>
        <p className="mt-2 mb-0 whitespace-pre-wrap border-t border-line0 pt-2 text-sm">{data.content.body}</p>
        {data.attachment ? (
          <p className="mt-2 mb-0 flex items-center gap-2 border-t border-line0 pt-2 text-sm">
            <span aria-hidden>📎</span>
            <span className="break-all">{data.attachment.pdfName}</span>
            <span className="ui-text-muted">({Math.round(data.attachment.pdfSize / 1024)} KB)</span>
          </p>
        ) : null}
      </div>
      {data.allowed ? (
        <button type="button" onClick={() => onOpen({ mode: 'email' })} className="ui-link text-sm">
          Editar o e-mail →
        </button>
      ) : (
        <p className="m-0 text-sm ui-text-muted">{data.reason}</p>
      )}
    </div>
  );
}

function VersionPreview({
  analysisId,
  versionId,
  onOpen,
}: {
  analysisId: string;
  versionId: string;
  onOpen: (panel: Panel) => void;
}) {
  const [data, setData] = useState<{
    version: { label: string; filename: string };
    sections: Array<{ heading: string; body: string }> | null;
    references: Array<{ n: number; documentId: string; document: string; page: number; excerpt: string }>;
  } | null>(null);
  const [viewMode, setMode] = useState<'word' | 'citacoes'>('word');

  useEffect(() => {
    void fetch(`/api/analyses/${analysisId}/versions/${versionId}/preview`)
      .then((r) => r.json())
      .then((d) => d.ok && setData(d));
  }, [analysisId, versionId]);

  if (!data) return <p className="m-0 text-base ui-text-muted">A carregar…</p>;
  const refByN = new Map(data.references.map((r) => [r.n, r]));
  const docxUrl = `/api/analyses/${analysisId}/versions/${versionId}/download`;

  const renderBody = (body: string) => {
    const parts = body.split(/(\[\d{1,3}\])/g);
    return parts.map((part, i) => {
      const match = /^\[(\d{1,3})\]$/.exec(part);
      if (!match) return <span key={i}>{part}</span>;
      const ref = refByN.get(Number(match[1]));
      if (!ref) return <span key={i}>{part}</span>;
      return (
        <CitationChip key={i} documentId={ref.documentId} page={ref.page} excerpt={ref.excerpt} onOpen={onOpen} />
      );
    });
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 font-mono text-sm ui-text-muted">
          {data.version.label} · {data.version.filename}
        </p>
        <div className="flex gap-1">
          {(['word', 'citacoes'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setMode(mode)}
              className={`rounded-md px-2.5 py-1 text-sm ${mode === viewMode ? 'bg-accent-soft font-medium text-accent-strong' : 'ui-btn-secondary'}`}
            >
              {mode === 'word' ? 'Documento Word' : 'Texto + citações'}
            </button>
          ))}
        </div>
      </div>
      {viewMode === 'word' ? (
        <DocxPreview source={{ url: docxUrl }} />
      ) : !data.sections ? (
        <EmptyState title="Versão manual" description="Esta versão foi carregada manualmente — veja-a no separador Documento Word." />
      ) : (
        <>
          {data.sections.map((section, i) => (
            <div key={i}>
              <p className="m-0 mb-1 text-base font-semibold text-ink0">{section.heading}</p>
              <p className="m-0 text-sm leading-relaxed">{renderBody(section.body)}</p>
            </div>
          ))}
          <div className="border-t border-line0 pt-2">
            <p className="m-0 mb-1.5 text-base font-semibold text-ink0">Anexo de fontes</p>
            <ul className="m-0 grid list-none gap-1 p-0 text-sm">
              {data.references.map((ref) => (
                <li key={ref.n} className="flex items-start gap-2">
                  <span className="font-mono">[{ref.n}]</span>
                  <span className="min-w-0">
                    {ref.document}{' '}
                    <CitationChip documentId={ref.documentId} page={ref.page} excerpt={ref.excerpt} onOpen={onOpen} />
                    <span className="ui-text-muted"> “{ref.excerpt.slice(0, 90)}…”</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
