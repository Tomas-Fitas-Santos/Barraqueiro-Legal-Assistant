'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { ContextHelpLink } from '@/components/help/context-help-link';
import { usePreview } from '@/components/library/preview-context';
import { PreviewDrawer } from '@/components/library/preview-drawer';
import {
  analysisTypeForTemplatePath,
  documentKind,
  DOCUMENT_KIND_LABELS,
  TEMPLATE_FILE_PURPOSES,
  templateFileKind,
  type DocumentKind,
} from '@/lib/library-layout';
import { Card, EmptyState, PageHeader } from '@/components/ui/page';
import type { HelpContextId } from '@/lib/help-contexts';
import {
  ANALYSIS_STATE_LABELS,
  ANALYSIS_TYPE_LABELS,
  APPROVAL_STATUSES,
  APPROVAL_STATUS_LABELS,
  CLIENT_DOCUMENT_STATE_LABELS,
  CONVERSION_STATE_LABELS,
  DOC_TYPES,
  RELATION_TYPES,
  RELATION_CONFIDENCE_LABELS,
  RELATION_STATUS_LABELS,
  RELATION_TYPE_LABELS,
  approvalStatusLabel,
  docTypeLabel,
  ocrQualityLabel,
  type AnalysisState,
  type AnalysisType,
  type ClientDocumentState,
  type ConversionState,
  type RelationType,
} from '@/lib/types';

// A document, in full: what it is (§8's metadata, correctable), what it relates to (§9, in
// both directions), which analyses used it and what those produced, and its text.
//
// Five tabs rather than one long page, because these are five different questions and only
// one of them is ever being asked. The tab lives in the URL so a link can point at the
// answer rather than at the document.

export type DocumentPayload = {
  ok: boolean;
  document: DocumentDetail;
  pages: Array<{ page: number; ocr: boolean; pendingOcr: boolean; text: string }>;
  relations: RelationRow[];
  analyses: DocumentAnalysisRow[];
  generatedBy: {
    analysisId: string;
    conversionId: string;
    versionId: string;
    type: 'summary' | 'revision';
    mainDocumentName: string;
    versionLabel: string;
    approvalState: string;
  } | null;
  staleOcrPages: number;
  /** Non-empty when this file is one of the app's own templates, and so is editable here. */
  editableTemplateId: string;
  workCounts: { relations: number; analyses: number };
};

export type DocumentDetail = {
  documentId: string;
  name: string;
  title: string;
  docType: string;
  path: string;
  clientState: ClientDocumentState;
  stateDetail: string;
  pageCount: number;
  ocrPendingPages: number;
  parentDocumentId: string;
  sourceKind: string;
  sha256: string;
  subject: string;
  issuedDate: string;
  effectiveDate: string;
  expiryDate: string;
  approvalStatus: string;
  language: string;
  entity: string;
  groupArea: string;
  versionLabel: string;
  extractorVersion: string;
  ocrQuality: string;
  structure: { headings: number; lists: number; tables: number; tableConfidence: 'n/a' | 'baixa' };
  classifiedAt: number;
  topics: string[];
  subtopics: string[];
  legislation: string[];
  obligations: string[];
  deadlines: string[];
  correctedFields: string[];
  references: Array<{ text: string; citation: { page: number } }>;
};

type RelationEvidence = {
  ai?: { rationale?: string; citation?: { documentId: string; page: number; excerpt: string; verified: boolean } | null };
  enforcementNote?: string;
  heuristic?: string;
};

/** One reason a pair is related. A pair can have several; it is still one relation. */
type RelationMotive = {
  relationId: string;
  type: RelationType;
  direction: 'outbound' | 'inbound';
  confidence: { level: string; basis: string };
  status: 'proposed' | 'confirmed' | 'rejected';
  proposedBy: 'engine' | 'ai' | 'user';
  evidence: RelationEvidence;
};

export type RelationRow = {
  relationId: string;
  otherDocumentId: string;
  otherDocumentName: string;
  status: 'proposed' | 'confirmed' | 'rejected';
  confidence: { level: string; basis: string };
  motives: RelationMotive[];
};

export type DocumentAnalysisRow = {
  analysisId: string;
  type: AnalysisType;
  state: AnalysisState;
  closedAt: number | null;
  role: 'main' | 'related';
  status: 'pending' | 'confirmed' | 'excluded';
  mainDocumentName: string;
  updatedAt: number;
  outputs: Array<{
    conversionId: string;
    versionId: string;
    pdfFilename: string;
    state: string;
    approvedAt: number | null;
    documentId: string;
  }>;
};

export type LibraryDoc = { documentId: string; name: string; path: string };

const TABS = [
  ['resumo', 'Resumo'],
  ['metadados', 'Metadados'],
  ['relacoes', 'Relações'],
  ['analises', 'Análises'],
  ['texto', 'Texto'],
] as const;
type Tab = (typeof TABS)[number][0];

/**
 * Which tabs a document has depends on WHAT IT IS.
 *
 * The three folders hold three different things, and showing all five tabs for each of them
 * meant offering a template a Metadados panel with nothing in it and a Relações panel it can
 * never have an answer for. A template is a stencil: it is not read, so it has no metadata,
 * no page text and nothing to be related to. A generated document is our own output — its
 * provenance is known exactly, so it gets Análises and never proposed relations.
 */
const TABS_BY_KIND: Record<DocumentKind, readonly Tab[]> = {
  official: ['resumo', 'metadados', 'relacoes', 'analises', 'texto'],
  template: ['resumo'],
  generated: ['resumo', 'analises'],
};

const STATUS_PILLS: Record<RelationRow['status'], string> = {
  proposed: 'ui-pill-info',
  confirmed: 'ui-pill-ok',
  rejected: 'ui-pill-warn',
};

const ROLE_LABELS: Record<DocumentAnalysisRow['role'], string> = {
  main: 'Documento principal',
  related: 'Documento relacionado',
};

function formatDate(ms: number): string {
  return ms ? new Date(ms).toLocaleDateString('pt-PT') : '—';
}

export type TutorialDocumentDetail = {
  payload: DocumentPayload;
  docs?: LibraryDoc[];
  target: string;
  onAction: () => void;
  previewContent?: React.ReactNode;
  previewDownloadHref?: string;
};

export function DocumentDetailView({ documentId, tutorial }: { documentId: string; tutorial?: TutorialDocumentDetail }) {
  const router = useRouter();
  const params = useSearchParams();
  const preview = usePreview();

  const [payload, setPayload] = useState<DocumentPayload | null>(tutorial?.payload || null);
  const [docs, setDocs] = useState<LibraryDoc[]>(tutorial?.docs || []);
  const [tutorialTab, setTutorialTab] = useState<Tab>('resumo');
  const [tutorialPreviewOpen, setTutorialPreviewOpen] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [notice, setNotice] = useState('');
  const [manualTo, setManualTo] = useState('');
  const [manualType, setManualType] = useState<RelationType>('cita');

  const refresh = useCallback(async () => {
    const [doc, list] = await Promise.all([
      fetch(`/api/library/documents/${documentId}`).then((r) => r.json()),
      fetch('/api/library/documents').then((r) => r.json()),
    ]);
    if (doc.ok) setPayload(doc);
    // Only source material can be the other end of a documental relation. A relation to a
    // generated document is PROVENANCE — known, not judged — and it belongs in Análises;
    // offering it here would let the two universes be mixed by hand (§9, E3).
    if (list.ok) {
      setDocs(
        list.documents.filter(
          (d: LibraryDoc) => d.documentId !== documentId && documentKind(d.path) === 'official',
        ),
      );
    }
  }, [documentId]);

  useEffect(() => {
    if (!tutorial) void refresh();
  }, [refresh, tutorial]);

  useEffect(() => {
    if (!tutorial) return;
    setPayload(tutorial.payload);
    setDocs(tutorial.docs || []);
    if (tutorial.target !== 'preview-button' && tutorial.target !== 'preview-panel') setTutorialPreviewOpen(false);
  }, [tutorial]);

  function selectTab(next: Tab) {
    if (tutorial) { setTutorialTab(next); if ((next === 'relacoes' && tutorial.target === 'relations-tab') || (next === 'analises' && tutorial.target === 'analyses-tab')) tutorial.onAction(); return; }
    const search = new URLSearchParams(params.toString());
    if (next === 'resumo') search.delete('tab');
    else search.set('tab', next);
    router.replace(`/library/${documentId}${search.toString() ? `?${search}` : ''}` as Route);
  }

  async function processDoc(reocr = false) {
    setProcessing(true);
    setNotice('');
    try {
      const data = await fetch(`/api/library/documents/${documentId}/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true, reocr }),
      }).then((r) => r.json());
      setNotice(
        data.ok
          ? `Processado — ${data.result.pageCount} página(s), ${data.result.segments} segmento(s)${data.result.ocrPending ? `, ${data.result.ocrPending} por transcrever` : ''}.`
          : data.error || 'O processamento falhou.',
      );
      await refresh();
    } finally {
      setProcessing(false);
    }
  }

  async function propose() {
    setProposing(true);
    setNotice('');
    try {
      const data = await fetch(`/api/library/documents/${documentId}/relations/propose`, { method: 'POST' }).then((r) =>
        r.json(),
      );
      setNotice(
        !data.ok
          ? data.error || 'A proposta de relações falhou.'
          : `${data.run.shortlisted} candidato(s), ${data.run.proposed} proposta(s)` +
              (data.run.judged ? '' : ' (heurística — AI não configurada)') +
              (data.run.enforced ? `, ${data.run.enforced} reclassificada(s) pela regra da referência exata` : '') +
              '.',
      );
      await refresh();
    } finally {
      setProposing(false);
    }
  }

  async function decide(relationId: string, decision: 'confirmed' | 'rejected') {
    if (tutorial) { setPayload((current) => current ? { ...current, relations: current.relations.map((relation) => relation.relationId === relationId ? { ...relation, status: decision } : relation) } : current); tutorial.onAction(); return; }
    await fetch(`/api/relations/${relationId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    await refresh();
  }

  async function addManual() {
    if (!manualTo) return;
    const data = await fetch(`/api/library/documents/${documentId}/relations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toDocumentId: manualTo, type: manualType }),
    }).then((r) => r.json());
    if (!data.ok) setNotice(data.error || 'Não foi possível adicionar a relação.');
    setManualTo('');
    await refresh();
  }

  async function saveMetadata(body: Record<string, unknown>) {
    const data = await fetch(`/api/library/documents/${documentId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    if (!data.ok) setNotice(data.error || 'Não foi possível guardar.');
    await refresh();
  }

  if (!payload) return null;
  const doc = payload.document;
  const kind = documentKind(doc.path);
  const tabs = TABS_BY_KIND[kind];
  const requested = tutorial ? tutorialTab : (TABS.find(([key]) => key === params.get('tab'))?.[0] || 'resumo') as Tab;
  // A tab this kind does not have falls back to Resumo rather than rendering nothing —
  // links and bookmarks survive a document being moved between folders.
  const tab: Tab = tabs.includes(requested) ? requested : 'resumo';
  const helpForTab = (): HelpContextId => {
    if (kind === 'template') return 'library.template';
    if (kind === 'generated') return 'library.result';
    return ({
      resumo: 'library.official.summary',
      metadados: 'library.official.metadata',
      relacoes: 'library.official.relations',
      analises: 'library.official.analyses',
      texto: 'library.official.text',
    } as const)[tab];
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={doc.title || doc.name}
        description={[doc.title ? doc.name : '', doc.path, doc.parentDocumentId ? 'anexo de um e-mail' : '']
          .filter(Boolean)
          .join(' · ')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-tutorial-target={tutorial ? 'preview-button' : undefined}
              onClick={() => { if (tutorial) { setTutorialPreviewOpen(true); tutorial.onAction(); } else preview.open({ documentId, name: doc.name }); }}
              className="ui-btn-primary rounded-md px-3.5 py-1.5 text-base"
            >
              Pré-visualizar
            </button>
            {payload.editableTemplateId ? (
              <Link
                // Carries where it came from, so the editor can offer a way back to it.
                href={`/templates/${payload.editableTemplateId}?from=/library/${documentId}` as Route}
                data-tutorial-target={tutorial?.target === 'edit-template' ? 'edit-template' : undefined}
                onClick={(event) => { if (tutorial) { event.preventDefault(); tutorial.onAction(); } }}
                className="ui-btn-secondary rounded-md px-3.5 py-1.5 text-base no-underline"
              >
                Editar
              </Link>
            ) : null}
            {tutorial?.target === 'upload-template' ? <button type="button" data-tutorial-target="upload-template" onClick={tutorial.onAction} className="ui-btn-secondary rounded-md px-3.5 py-1.5 text-base">Carregar novo Template</button> : null}
            {kind === 'official' ? (
              <button
                type="button"
                disabled={processing}
                onClick={() => processDoc()}
                className="ui-btn-secondary rounded-md px-3.5 py-1.5 text-base"
              >
                {processing ? 'A processar…' : 'Reprocessar'}
              </button>
            ) : null}
            {kind === 'official' && payload.staleOcrPages > 0 ? (
              <button
                type="button"
                disabled={processing}
                onClick={() => processDoc(true)}
                title={`${payload.staleOcrPages} página(s) foram transcritas por uma versão anterior. Voltar a transcrever tem custo por página.`}
                className="ui-btn-secondary rounded-md px-3.5 py-1.5 text-base"
              >
                Voltar a transcrever
              </button>
            ) : null}
            <a
              href={`/api/library/documents/${documentId}/download`}
              className="ui-btn-secondary rounded-md px-3.5 py-1.5 text-base no-underline"
            >
              Descarregar
            </a>
            <Link
              href="/library"
              data-tutorial-target={tutorial?.target === 'library-back' ? 'library-back' : undefined}
              onClick={(event) => { if (tutorial) { event.preventDefault(); if (tutorial.target === 'library-back') tutorial.onAction(); } }}
              className="ui-btn-secondary rounded-md px-3.5 py-1.5 text-base no-underline"
            >
              ← Biblioteca
            </Link>
          </div>
        }
      />

      <div className={`mb-4 flex-wrap gap-1.5 ${tabs.length > 1 ? 'flex' : 'hidden'}`}>
        {TABS.filter(([key]) => tabs.includes(key)).map(([key, label]) => (
          <button
            key={key}
            type="button"
            data-tutorial-target={tutorial && key === 'relacoes' ? 'relations-tab' : tutorial && key === 'analises' ? 'analyses-tab' : undefined}
            onClick={() => selectTab(key)}
            className={`rounded-md px-4 py-1.5 text-base ${
              tab === key ? 'bg-accent-soft font-medium text-accent-strong' : 'ui-btn-secondary'
            }`}
          >
            <span>{label}</span>
            {key === 'relacoes' && payload.workCounts.relations > 0 ? (
              <span className="ui-pill-warn ml-2 rounded-full px-1.5 py-0.5 text-xs" aria-label={`${payload.workCounts.relations} relações por confirmar`}>
                {payload.workCounts.relations}
              </span>
            ) : null}
            {key === 'analises' && payload.workCounts.analyses > 0 ? (
              <span className="ui-pill-accent ml-2 rounded-full px-1.5 py-0.5 text-xs" aria-label={`${payload.workCounts.analyses} análises por concluir`}>
                {payload.workCounts.analyses}
              </span>
            ) : null}
          </button>
        ))}
        <ContextHelpLink context={helpForTab()} className="ml-1 self-center" />
      </div>

      {notice ? <p className="mb-3 text-base ui-text-muted">{notice}</p> : null}

      <div className="grid min-h-0 flex-1 content-start gap-6 overflow-y-auto pr-1">
        {tab === 'resumo' ? (
          <ResumoTab doc={doc} kind={kind} generatedBy={payload.generatedBy} editableTemplateId={payload.editableTemplateId} tutorialTarget={tutorial?.target} onTutorialAction={tutorial?.onAction} />
        ) : tab === 'metadados' ? (
          <MetadadosTab doc={doc} onSave={saveMetadata} />
        ) : tab === 'relacoes' ? (
          <RelacoesTab
            relations={payload.relations}
            docs={docs}
            proposing={proposing}
            manualTo={manualTo}
            manualType={manualType}
            setManualTo={setManualTo}
            setManualType={setManualType}
            onPropose={propose}
            onDecide={decide}
            onAddManual={addManual}
            tutorialTarget={tutorial?.target}
          />
        ) : tab === 'analises' ? (
          <div data-tutorial-target={tutorial?.target === 'analyses-list' ? 'analyses-list' : undefined}>
            <AnalisesTab analyses={payload.analyses} />
          </div>
        ) : (
          <TextoTab pages={payload.pages} onPreviewPage={(page) => preview.open({ documentId, name: doc.name, page })} />
        )}
      </div>
      {tutorial ? <PreviewDrawer target={tutorialPreviewOpen ? { documentId, name: doc.name } : null} onClose={() => setTutorialPreviewOpen(false)} modal={false} contained tutorialTarget={tutorial.target === 'preview-panel' ? 'preview-panel' : undefined} content={tutorial.previewContent} downloadHref={tutorial.previewDownloadHref} /> : null}
    </div>
  );
}

// --- Resumo ------------------------------------------------------------------------------

function ResumoTab({
  doc,
  kind,
  generatedBy,
  editableTemplateId,
  tutorialTarget,
  onTutorialAction,
}: {
  doc: DocumentDetail;
  kind: DocumentKind;
  generatedBy: DocumentPayload['generatedBy'];
  editableTemplateId: string;
  tutorialTarget?: string;
  onTutorialAction?: () => void;
}) {
  // Neither a template nor a generated document is read as a document, so every indexing
  // field below would be a dash. What they have instead is an identity: what kind of file
  // this is, which workflow it belongs to, and where it sits.
  if (kind !== 'official') {
    const workflow = analysisTypeForTemplatePath(doc.path);
    const templateKind = kind === 'template' ? templateFileKind(doc.name) : null;
    const templatePurpose = templateKind ? TEMPLATE_FILE_PURPOSES[templateKind] : null;
    return (
      <div data-tutorial-target={tutorialTarget === 'template-purpose' ? 'template-purpose' : tutorialTarget === 'result-summary' ? 'result-summary' : undefined} className="grid gap-6">
        {generatedBy ? (
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="m-0 text-sm font-medium uppercase tracking-wide text-accent-strong">Proveniência</p>
                <h2 className="mt-1 mb-0 text-xl font-semibold text-ink0">{ANALYSIS_TYPE_LABELS[generatedBy.type]}</h2>
                <p className="mt-1 mb-0 text-base">Criado a partir de <strong>{generatedBy.mainDocumentName}</strong>, versão {generatedBy.versionLabel}.</p>
                <p className="mt-1 mb-0 text-sm ui-text-muted">A aprovação e todas as versões permanecem registadas na análise de origem.</p>
              </div>
              <Link href={`/analyses/${generatedBy.analysisId}` as Route} data-tutorial-target={tutorialTarget === 'open-origin' ? 'open-origin' : undefined} onClick={(event) => { if (onTutorialAction) { event.preventDefault(); onTutorialAction(); } }} className="ui-btn-primary rounded-md px-3 py-1.5 text-sm no-underline">
                Abrir análise de origem
              </Link>
            </div>
          </Card>
        ) : null}
        <Card>
          <h2 className="m-0 mb-4 text-xl font-semibold text-ink0">Resumo</h2>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-base">
            <dt className="ui-text-muted">Tipo de ficheiro</dt>
            <dd className="m-0">{templatePurpose?.label || DOCUMENT_KIND_LABELS[kind]}</dd>
            {templatePurpose ? (
              <>
                <dt className="ui-text-muted">Serve para</dt>
                <dd className="m-0">{templatePurpose.purpose}</dd>
              </>
            ) : null}
            {workflow ? (
              <>
                <dt className="ui-text-muted">Fluxo</dt>
                <dd className="m-0">{ANALYSIS_TYPE_LABELS[workflow]}</dd>
              </>
            ) : null}
            <dt className="ui-text-muted">Localização no OneDrive</dt>
            <dd className="m-0">{doc.path || '—'}</dd>
            <dt className="ui-text-muted">Hash (SHA-256)</dt>
            <dd className="m-0 break-all font-mono text-sm">{doc.sha256 || '—'}</dd>
          </dl>
          <p className="mt-4 mb-0 text-base ui-text-muted">
            {kind === 'template'
              ? templatePurpose
                ? templateKind === 'docx' && !editableTemplateId
                  ? 'Este é um template fornecido externamente. Para o alterar, edite o DOCX fora da aplicação e substitua-o nesta pasta.'
                  : templatePurpose.authoring
                : 'Este formato não é usado como template pela aplicação. Use DOCX para documentos, EML para e-mails ou JSON para campos.'
              : 'Um documento gerado é produzido por esta aplicação. A sua proveniência é conhecida e está no separador Análises.'}
          </p>
          {kind === 'template' && templateKind === 'docx' ? (
            <p className="mt-2 mb-0 text-sm ui-text-muted">
              Para usar um template novo, carregue o DOCX em <strong>2. Templates</strong>, dentro da pasta <strong>Resumo documental</strong> ou <strong>Revisão e Atualização</strong>. A pasta indica em que fluxo será usado e a aplicação valida os campos necessários.
            </p>
          ) : null}
        </Card>
      </div>
    );
  }
  return (
    <div className="grid gap-6">
      {generatedBy ? (
        <Card>
          <p className="m-0 text-base">
            Este documento foi gerado pela aplicação.{' '}
            <Link href={`/analyses/${generatedBy.analysisId}` as Route} className="ui-link">
              Abrir a análise que o produziu
            </Link>
          </p>
        </Card>
      ) : null}
      <div data-tutorial-target={tutorialTarget === 'document-summary' ? 'document-summary' : undefined}>
      <Card>
        <h2 className="m-0 mb-4 text-xl font-semibold text-ink0">Resumo</h2>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-base">
          <dt className="ui-text-muted">Estado da indexação</dt>
          <dd className="m-0">
            {CLIENT_DOCUMENT_STATE_LABELS[doc.clientState]}
            {doc.stateDetail ? <span className="ui-text-muted"> — {doc.stateDetail}</span> : null}
          </dd>
          <dt className="ui-text-muted">Estado do documento</dt>
          <dd className="m-0">{approvalStatusLabel(doc.approvalStatus)}</dd>
          <dt className="ui-text-muted">Tipo documental</dt>
          <dd className="m-0">{docTypeLabel(doc.docType)}</dd>
          <dt className="ui-text-muted">Assunto</dt>
          <dd className="m-0">{doc.subject || '—'}</dd>
          <dt className="ui-text-muted">Páginas</dt>
          <dd className="m-0">
            {doc.pageCount}
            {doc.ocrPendingPages > 0 ? ` (${doc.ocrPendingPages} por transcrever)` : ''}
          </dd>
          <dt className="ui-text-muted">Qualidade do OCR</dt>
          <dd className="m-0">{ocrQualityLabel(doc.ocrQuality)}</dd>
          <dt className="ui-text-muted">Data de indexação</dt>
          <dd className="m-0">{formatDate(doc.classifiedAt)}</dd>
          <dt className="ui-text-muted">Estrutura reconhecida</dt>
          <dd className="m-0">
            {doc.structure.headings + doc.structure.lists + doc.structure.tables === 0
              ? '—'
              : `${doc.structure.headings} título(s), ${doc.structure.lists} item(ns) de lista, ${doc.structure.tables} tabela(s)`}
            {doc.structure.tableConfidence === 'baixa' ? (
              <span className="ui-text-muted"> — deteção de tabelas com confiança baixa</span>
            ) : null}
          </dd>
          <dt className="ui-text-muted">Versão do extrator</dt>
          <dd className="m-0 font-mono text-sm">{doc.extractorVersion || '—'}</dd>
          <dt className="ui-text-muted">Localização no OneDrive</dt>
          <dd className="m-0">{doc.path || '—'}</dd>
          <dt className="ui-text-muted">Hash (SHA-256)</dt>
          <dd className="m-0 break-all font-mono text-sm">{doc.sha256 || '—'}</dd>
        </dl>
      </Card>
      </div>
      {doc.references.length > 0 ? (
        <Card>
          <h2 className="m-0 mb-3 text-xl font-semibold text-ink0">Referências encontradas no texto</h2>
          <ul className="m-0 list-none p-0 text-base">
            {doc.references.map((ref, i) => (
              <li key={i} className="ui-text-muted">
                {ref.text} <span className="font-mono text-sm">(p.{ref.citation.page})</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

// --- Metadados ---------------------------------------------------------------------------

type EditableField =
  | { key: string; label: string; kind: 'text' }
  | { key: string; label: string; kind: 'list' }
  | { key: string; label: string; kind: 'enum'; options: readonly string[]; optionLabel: (v: string) => string };

const EDITABLE_FIELDS: EditableField[] = [
  { key: 'title', label: 'Título', kind: 'text' },
  { key: 'docType', label: 'Tipo documental', kind: 'enum', options: DOC_TYPES, optionLabel: docTypeLabel },
  { key: 'subject', label: 'Assunto', kind: 'text' },
  { key: 'topics', label: 'Tema', kind: 'list' },
  { key: 'subtopics', label: 'Subtemas', kind: 'list' },
  { key: 'entity', label: 'Entidade', kind: 'text' },
  { key: 'groupArea', label: 'Área do Grupo', kind: 'text' },
  { key: 'issuedDate', label: 'Data do documento', kind: 'text' },
  { key: 'effectiveDate', label: 'Início de vigência', kind: 'text' },
  { key: 'expiryDate', label: 'Fim de vigência', kind: 'text' },
  { key: 'versionLabel', label: 'Número de versão', kind: 'text' },
  {
    key: 'approvalStatus',
    label: 'Estado do documento',
    kind: 'enum',
    options: APPROVAL_STATUSES,
    optionLabel: (v) => APPROVAL_STATUS_LABELS[v as keyof typeof APPROVAL_STATUS_LABELS] || v,
  },
  { key: 'language', label: 'Idioma', kind: 'text' },
  { key: 'legislation', label: 'Legislação citada', kind: 'list' },
  { key: 'obligations', label: 'Obrigações', kind: 'list' },
  { key: 'deadlines', label: 'Datas e prazos', kind: 'list' },
];

function MetadadosTab({ doc, onSave }: { doc: DocumentDetail; onSave: (body: Record<string, unknown>) => Promise<void> }) {
  const corrected = new Set(doc.correctedFields);
  const value = (key: string): string => {
    const raw = (doc as unknown as Record<string, unknown>)[key];
    return Array.isArray(raw) ? raw.join(', ') : String(raw ?? '');
  };

  return (
    <Card>
      <h2 className="m-0 mb-1 text-xl font-semibold text-ink0">Metadados</h2>
      <p className="mt-0 mb-5 text-base ui-text-muted">
        Identificados automaticamente e sujeitos a correção. Um campo que corrija fica seu: um
        reprocessamento do documento deixa de lhe tocar.
      </p>
      <div className="grid gap-4">
        {EDITABLE_FIELDS.map((field) => (
          <MetadataRow
            key={field.key}
            field={field}
            value={value(field.key)}
            corrected={corrected.has(field.key)}
            onSave={onSave}
          />
        ))}
      </div>
    </Card>
  );
}

function MetadataRow({
  field,
  value,
  corrected,
  onSave,
}: {
  field: EditableField;
  value: string;
  corrected: boolean;
  onSave: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  // The row is a controlled input over a value that the server can change under it (a
  // reprocess, a reset). Re-seed the draft when it does, unless the user is mid-edit.
  useEffect(() => setDraft(value), [value]);
  const dirty = draft !== value;

  async function save() {
    setSaving(true);
    try {
      await onSave({ [field.key]: field.kind === 'list' ? draft.split(',') : draft });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-1.5 sm:grid-cols-[14rem_1fr] sm:items-center sm:gap-x-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base font-medium text-ink1">{field.label}</span>
        {corrected ? <span className="ui-pill-ok rounded-md px-2 py-0.5 text-sm">corrigido por si</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {field.kind === 'enum' ? (
          <select
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="ui-input min-w-48 rounded-md px-2.5 py-1.5 text-base"
          >
            <option value="">—</option>
            {field.options.map((option) => (
              <option key={option} value={option}>
                {field.optionLabel(option)}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={field.kind === 'list' ? 'separados por vírgulas' : ''}
            className="ui-input min-w-48 flex-1 rounded-md px-2.5 py-1.5 text-base"
          />
        )}
        {dirty ? (
          <button type="button" disabled={saving} onClick={save} className="ui-btn-primary rounded-md px-3 py-1.5 text-sm">
            {saving ? 'A guardar…' : 'Guardar'}
          </button>
        ) : null}
        {corrected && !dirty ? (
          <button
            type="button"
            onClick={() => onSave({ reset: [field.key] })}
            className="ui-btn-secondary rounded-md px-3 py-1.5 text-sm"
            title="O valor atual mantém-se até ao próximo reprocessamento, que volta a preenchê-lo com a sugestão da AI."
          >
            Repor sugestão da AI
          </button>
        ) : null}
      </div>
    </div>
  );
}

// --- Relações ----------------------------------------------------------------------------

function RelacoesTab({
  relations,
  docs,
  proposing,
  manualTo,
  manualType,
  setManualTo,
  setManualType,
  onPropose,
  onDecide,
  onAddManual,
  tutorialTarget,
}: {
  relations: RelationRow[];
  docs: LibraryDoc[];
  proposing: boolean;
  manualTo: string;
  manualType: RelationType;
  setManualTo: (v: string) => void;
  setManualType: (v: RelationType) => void;
  onPropose: () => Promise<void>;
  onDecide: (relationId: string, decision: 'confirmed' | 'rejected') => Promise<void>;
  onAddManual: () => Promise<void>;
  tutorialTarget?: string;
}) {
  const pendingAtOpen = relations.some((relation) => relation.status === 'proposed');
  const [filter, setFilter] = useState<'todas' | 'confirmed' | 'proposed' | 'rejected'>(pendingAtOpen ? 'proposed' : 'todas');
  const counts = {
    todas: relations.length,
    confirmed: relations.filter((r) => r.status === 'confirmed').length,
    proposed: relations.filter((r) => r.status === 'proposed').length,
    rejected: relations.filter((r) => r.status === 'rejected').length,
  };
  const shown = filter === 'todas' ? relations : relations.filter((r) => r.status === filter);

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="m-0 text-xl font-semibold text-ink0">Prepare as relações antes das análises</h2>
          <p className="mt-1 mb-0 max-w-3xl text-sm ui-text-muted">
            Confirmar estes pares melhora as recomendações de documentos de apoio quando iniciar uma análise.
            A confiança explica a prova encontrada; a decisão continua a ser sua.
          </p>
        </div>
        <button type="button" onClick={onPropose} disabled={proposing} className="ui-btn-primary rounded-md px-3.5 py-1.5 text-base">
          {proposing ? 'A analisar…' : 'Procurar relações'}
        </button>
      </div>

      {/* Confirmed, still to decide, rejected — the three answers, so a library with a
          long tail of proposals can be read one answer at a time. */}
      <div className="mb-3 flex flex-wrap gap-1">
        {(['todas', 'confirmed', 'proposed', 'rejected'] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={`rounded-md px-2.5 py-1 text-sm ${
              filter === key ? 'bg-accent-soft font-medium text-accent-strong' : 'ui-btn-secondary'
            }`}
          >
            {key === 'todas' ? 'Todas' : RELATION_STATUS_LABELS[key]} ({counts[key]})
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <EmptyState
          title={relations.length === 0 ? 'Ainda sem relações' : 'Nenhuma relação neste estado'}
          description={
            relations.length === 0
              ? 'Procure relações automaticamente ou adicione uma abaixo.'
              : 'Escolha outro estado para ver as restantes.'
          }
        />
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {shown.map((rel) => (
            <li key={rel.otherDocumentId} className="ui-soft-panel rounded-lg p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="m-0 text-base">
                  <span className={`${STATUS_PILLS[rel.status]} mr-2 rounded-md px-2 py-0.5 text-sm`}>
                    {RELATION_STATUS_LABELS[rel.status]}
                  </span>
                  {/* The decision and the evidence are different facts, so the band stays
                      visible after the pair has been decided. */}
                  <span
                    className={`mr-2 rounded-md px-2 py-0.5 text-sm ${
                      rel.confidence.level === 'nao_confirmada' ? 'ui-pill-warn' : 'ui-pill-info'
                    }`}
                    title={rel.confidence.basis}
                  >
                    {RELATION_CONFIDENCE_LABELS[rel.confidence.level] || rel.confidence.level}
                  </span>
                  <Link href={`/library/${rel.otherDocumentId}` as Route} className="ui-link">
                    {rel.otherDocumentName}
                  </Link>
                </p>
                {rel.status === 'proposed' ? (
                  <span className="flex gap-2">
                    <button type="button" data-tutorial-target={tutorialTarget === 'confirm-relation' ? 'confirm-relation' : undefined} title="Passa a recomendar este documento como fonte de apoio." onClick={() => onDecide(rel.relationId, 'confirmed')} className="ui-btn-primary rounded-md px-3 py-1 text-sm">
                      Confirmar relação
                    </button>
                    <button type="button" title="Este par deixa de ser recomendado em análises futuras." onClick={() => onDecide(rel.relationId, 'rejected')} className="ui-btn-secondary rounded-md px-3 py-1 text-sm">
                      Não estão relacionados
                    </button>
                  </span>
                ) : null}
              </div>

              {/* The motives. An inbound one reads with the OTHER document as the subject —
                  the type is never flipped into its inverse, because that would assert an
                  edge nobody judged. */}
              <ul className="m-0 mt-2 flex list-none flex-wrap gap-1.5 p-0">
                {rel.motives.map((m) => (
                  <li
                    key={m.relationId}
                    className="ui-pill-info rounded-md px-2 py-0.5 text-sm"
                    title={m.confidence.basis}
                  >
                    {m.direction === 'outbound'
                      ? `este documento ${RELATION_TYPE_LABELS[m.type]} ${rel.otherDocumentName}`
                      : `${rel.otherDocumentName} ${RELATION_TYPE_LABELS[m.type]} este documento`}
                  </li>
                ))}
              </ul>

              <p className="mt-2 mb-0 text-sm ui-text-muted">{rel.confidence.basis}</p>
              {rel.motives.map((m) => (
                <div key={`ev:${m.relationId}`}>
                  {m.evidence.ai?.rationale ? <p className="mt-2 mb-0 text-sm ui-text-muted">{m.evidence.ai.rationale}</p> : null}
                  {m.evidence.ai?.citation ? (
                    <p className="mt-1 mb-0 text-sm ui-text-muted">
                      Evidência: “{m.evidence.ai.citation.excerpt.slice(0, 140)}” (p.
                      {m.evidence.ai.citation.page}
                      {m.evidence.ai.citation.verified ? ', verificada' : ', NÃO verificada'})
                    </p>
                  ) : null}
                  {m.evidence.enforcementNote ? <p className="mt-1 mb-0 text-sm text-warn">{m.evidence.enforcementNote}</p> : null}
                  {m.evidence.heuristic ? <p className="mt-1 mb-0 text-sm ui-text-muted">{m.evidence.heuristic}</p> : null}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-5 border-t border-line0 pt-4">
        <p className="m-0 mb-2 font-medium text-ink1">Adicionar manualmente</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base ui-text-muted">Este documento</span>
          <select
            value={manualType}
            onChange={(e) => setManualType(e.target.value as RelationType)}
            className="ui-input rounded-md px-2.5 py-1.5 text-base"
          >
            {RELATION_TYPES.map((type) => (
              <option key={type} value={type}>
                {RELATION_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
          <select
            value={manualTo}
            onChange={(e) => setManualTo(e.target.value)}
            className="ui-input min-w-48 rounded-md px-2.5 py-1.5 text-base"
          >
            <option value="">— escolher documento —</option>
            {docs.map((d) => (
              <option key={d.documentId} value={d.documentId}>
                {d.name}
              </option>
            ))}
          </select>
          <button type="button" onClick={onAddManual} disabled={!manualTo} className="ui-btn-secondary rounded-md px-3 py-1.5 text-sm">
            Adicionar
          </button>
        </div>
      </div>
    </Card>
  );
}

// --- Análises ----------------------------------------------------------------------------

function AnalisesTab({ analyses }: { analyses: DocumentAnalysisRow[] }) {
  if (analyses.length === 0) {
    return (
      <EmptyState
        title="Este documento ainda não foi usado numa análise"
        description="Quando for, a análise e os documentos que produziu aparecem aqui."
      />
    );
  }
  return (
    <Card>
      <h2 className="m-0 mb-4 text-xl font-semibold text-ink0">Análises em que foi utilizado</h2>
      <ul className="m-0 grid list-none gap-3 p-0">
        {analyses.map((analysis) => (
          <li key={analysis.analysisId} className="ui-soft-panel rounded-lg p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="m-0 text-base">
                <Link href={`/analyses/${analysis.analysisId}` as Route} className="ui-link font-medium">
                  {ANALYSIS_TYPE_LABELS[analysis.type]} — {analysis.mainDocumentName}
                </Link>
              </p>
              <span className="text-sm ui-text-muted">
                {ROLE_LABELS[analysis.role]} · {ANALYSIS_STATE_LABELS[analysis.state]} · {formatDate(analysis.updatedAt)}
              </span>
            </div>
            {analysis.outputs.length > 0 ? (
              <ul className="mt-2 mb-0 grid list-none gap-1 p-0 text-sm">
                {analysis.outputs.map((output) => (
                  <li key={output.conversionId} className="flex flex-wrap items-center gap-2">
                    {output.documentId ? (
                      <Link href={`/library/${output.documentId}` as Route} className="ui-link no-underline">
                        {output.pdfFilename || 'Documento gerado'}
                      </Link>
                    ) : (
                      <span>{output.pdfFilename || 'Documento gerado'}</span>
                    )}
                    <span className="ui-text-muted">
                      {CONVERSION_STATE_LABELS[output.state as ConversionState] || output.state}
                    </span>
                    <a
                      href={`/api/analyses/${analysis.analysisId}/versions/${output.versionId}/download`}
                      className="ui-link no-underline text-sm"
                    >
                      Descarregar
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// --- Texto -------------------------------------------------------------------------------

/**
 * The stored page text is Markdown — that IS the extracted structure, and it is what a
 * citation's excerpt is taken from. Shown here as what it means rather than as its markers.
 */
function PageBlocks({ text }: { text: string }) {
  return (
    <div className="grid gap-2">
      {text.split('\n\n').map((block, i) => {
        if (block.startsWith('|')) {
          return (
            <pre key={i} className="ui-soft-panel m-0 overflow-x-auto rounded-md p-3 font-mono text-xs">
              {block}
            </pre>
          );
        }
        const heading = /^(#{1,2}) (.*)$/.exec(block);
        if (heading) {
          return (
            <p key={i} className={`m-0 font-semibold text-ink0 ${heading[1] === '#' ? 'text-base' : 'text-sm'}`}>
              {heading[2]}
            </p>
          );
        }
        return (
          <p key={i} className="m-0 whitespace-pre-wrap text-sm leading-relaxed">
            {block}
          </p>
        );
      })}
    </div>
  );
}

function TextoTab({
  pages,
  onPreviewPage,
}: {
  pages: DocumentPayload['pages'];
  onPreviewPage: (page: number) => void;
}) {
  if (pages.length === 0) {
    return (
      <EmptyState
        title="Sem texto extraído"
        description="Processe o documento para que a aplicação o leia e o possa citar."
      />
    );
  }
  return (
    <Card>
      <h2 className="m-0 mb-4 text-xl font-semibold text-ink0">Texto extraído</h2>
      <div className="grid gap-4">
        {pages.map((page) => (
          <div key={page.page}>
            <p className="m-0 mb-1 flex items-center gap-2 font-mono text-xs ui-text-muted">
              <button type="button" onClick={() => onPreviewPage(page.page)} className="ui-link font-mono text-xs">
                página {page.page}
              </button>
              {page.ocr ? <span>· transcrita por OCR</span> : null}
              {page.pendingOcr ? <span className="text-warn">· por transcrever</span> : null}
            </p>
            {page.text ? <PageBlocks text={page.text} /> : <p className="m-0 ui-text-muted">(sem texto)</p>}
          </div>
        ))}
      </div>
    </Card>
  );
}
