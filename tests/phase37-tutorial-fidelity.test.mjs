import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { loadTsModule } from './helpers.mjs';

describe('phase 37 — tutorial fidelity and browser isolation contracts', () => {
  it('returns a versioned definition with an explicit mode for every stable step', async () => {
    const tutorials = await loadTsModule('src/lib/tutorials.ts');
    assert.equal(tutorials.TUTORIAL_SCENARIO_VERSION, 6);
    for (const kind of tutorials.TUTORIAL_KINDS) {
      const raw = tutorials.TUTORIALS[kind];
      const normalized = tutorials.tutorialDefinition(kind);
      assert.deepEqual(normalized.steps.map((step) => step.id), raw.steps.map((step) => step.id));
      assert.ok(normalized.steps.every((step) => ['observe', 'action', 'input'].includes(step.mode)));
      assert.ok(normalized.steps.filter((step) => step.mode === 'observe').every((step) => !step.interaction));
      assert.ok(normalized.steps.filter((step) => step.interaction).every((step) => ['action', 'input'].includes(step.mode)));
    }
  });

  it('fails closed for live fetch and XMLHttpRequest traffic', () => {
    const guard = readFileSync('src/components/tutorials/tutorial-network-guard.tsx', 'utf8');
    assert.match(guard, /window\.fetch = guardedFetch/);
    assert.match(guard, /XMLHttpRequest\.prototype\.open = guardedOpen/);
    assert.match(guard, /!url\.pathname\.startsWith\('\/api\/tutorials\/'\)/);
    assert.match(guard, /Tutorial isolation blocked a live application request/);
  });

  it('confines mouse, keyboard and input while keeping contextual Help available', () => {
    const workspace = readFileSync('src/components/tutorials/tutorial-workspace.tsx', 'utf8');
    assert.match(workspace, /onClickCapture=\{confine\}/);
    assert.match(workspace, /onKeyDownCapture=\{confineKeyboard\}/);
    assert.match(workspace, /onInputCapture=/);
    assert.match(workspace, /data-tutorial-utility="help"/);
    assert.match(workspace, /event\.preventDefault\(\); event\.stopPropagation\(\)/);
  });

  it('uses an unclipped high-contrast focus frame and anchored coach mark', () => {
    const workspace = readFileSync('src/components/tutorials/tutorial-workspace.tsx', 'utf8');
    assert.match(workspace, /data-tutorial-focus-frame/);
    assert.match(workspace, /targetRect\.width \+ 10/);
    assert.match(workspace, /<TutorialCoachMark/);
    assert.match(workspace, /bg-slate-950\/\[0\.08\]/);
    assert.match(workspace, /shadow-\[0_0_0_3px_#174ea6/);
    assert.doesNotMatch(workspace, /TutorialCoachBar|tutorial-active-target/);
    const detail = readFileSync('src/components/library/document-detail-view.tsx', 'utf8');
    assert.match(detail, /<div data-tutorial-target=\{tutorialTarget === 'document-summary'[\s\S]*?<Card>[\s\S]*?<h2 className=/);
    assert.doesNotMatch(detail, /<h2 data-tutorial-target=\{tutorialTarget === 'document-summary'/);
  });

  it('auto-advances actions while observations keep an explicit acknowledgement', () => {
    const workspace = readFileSync('src/components/tutorials/tutorial-workspace.tsx', 'utf8');
    const repo = readFileSync('src/lib/server/repo/tutorials.ts', 'utf8');
    assert.match(workspace, /action: 'demo-next'/);
    assert.match(workspace, /mode === 'observe'/);
    assert.match(repo, /case 'demo-next'/);
    assert.match(repo, /steps\.slice\(step\)/);
  });

  it('uses one resizable half-width artifact viewer in production and training', () => {
    const slideOver = readFileSync('src/components/ui/slide-over.tsx', 'utf8');
    const analysis = readFileSync('src/components/analyses/analysis-chat-view.tsx', 'utf8');
    const workspace = readFileSync('src/components/tutorials/tutorial-workspace.tsx', 'utf8');

    assert.match(slideOver, /Math\.round\(safeAvailable \/ 2\)/);
    assert.match(slideOver, /data-slide-over-resize-handle/);
    assert.match(slideOver, /rect\.right - e\.clientX/);
    assert.match(slideOver, /contained && panelRef\.current\?\.parentElement/);

    // Extraction is an artifact like Word/PDF: it is opened by the shared SidePanel instead
    // of replacing the analysis workspace with a special inline review screen.
    assert.match(analysis, /\{panel \? \([\s\S]*?<SidePanel/);
    assert.doesNotMatch(analysis, /panelStack\[0\]\?\.mode === 'items'/);
    assert.match(analysis, /panel\.mode === 'document'[\s\S]*panel\.mode === 'version'[\s\S]*panel\.mode === 'pdf'[\s\S]*<ExtractionReview/);

    // The tutorial keeps the real chat/feed behind the same contained slide-over while the
    // isolated ExtractionReview is open, rather than swapping to a tutorial-only layout.
    assert.match(workspace, /const extractionPanelOpen = findingsIds\.has\(step\.id\)/);
    assert.match(workspace, /tab === 'chat'[\s\S]*?<FeedBubble[\s\S]*?extractionPanelOpen \? <SlideOver/);
    assert.match(workspace, /<SlideOver open contained modal=\{false\}[\s\S]*?<ExtractionReview/);
  });

  it('keeps tutorial previews inside the app viewport and the coach attached to them', () => {
    const detail = readFileSync('src/components/library/document-detail-view.tsx', 'utf8');
    const slideOver = readFileSync('src/components/ui/slide-over.tsx', 'utf8');
    assert.match(detail, /modal=\{false\} contained tutorialTarget=/);
    assert.match(slideOver, /contained \? panel : createPortal/);
    assert.match(slideOver, /data-tutorial-target=\{tutorialTarget\}/);
  });

  it('requires opening the real Template and Result rows before showing their detail', async () => {
    const tutorials = await loadTsModule('src/lib/tutorials.ts');
    const library = tutorials.tutorialDefinition('library').steps;
    assert.equal(library.find((step) => step.id === 'template-kinds').screen, 'template-list');
    assert.equal(library.find((step) => step.id === 'template-kinds').interaction.key, 'templateOpened');
    assert.equal(library.find((step) => step.id === 'result-detail').screen, 'results');
    assert.equal(library.find((step) => step.id === 'result-detail').interaction.key, 'resultOpened');
    assert.equal(library.find((step) => step.id === 'upload-template').mode, 'observe');
    assert.equal(library.find((step) => step.id === 'open-analyses').target, 'analyses-tab');
    assert.equal(library.find((step) => step.id === 'inspect-analyses').target, 'analyses-list');
  });

  it('renders remaining training surfaces through production components', () => {
    const workspace = readFileSync('src/components/tutorials/tutorial-workspace.tsx', 'utf8');
    for (const component of ['DocumentDetailView', 'TemplateEditorView', 'OutputSequence', 'EmailEditor', 'FeedBubble', 'DetalhesTab', 'HistoricoTab', 'DocumentList', 'NewAnalysisWizard', 'ExtractionReview']) {
      assert.match(workspace, new RegExp(`<${component}\\b`), component);
    }
    for (const removedCopy of ['LibraryDetailScreen', 'RelationsScreen', 'TemplateDetailScreen', 'ResultDetailScreen']) {
      assert.doesNotMatch(workspace, new RegExp(`function ${removedCopy}\\b`), removedCopy);
    }
  });

  it('keeps analysis tutorials inside one stateful production workspace', async () => {
    const tutorials = await loadTsModule('src/lib/tutorials.ts');
    const workspace = readFileSync('src/components/tutorials/tutorial-workspace.tsx', 'utf8');
    for (const kind of ['summary', 'revision']) {
      const steps = tutorials.tutorialDefinition(kind).steps;
      for (const id of ['open-history', 'select-stage', 'return-stage', 'describe-restart', 'inspect-branch', 'redo-chat', 'confirm-chat', 'view-original', 'activate-original', 'view-branch', 'activate-branch', 'approve-email', 'prepare-email']) {
        assert.ok(steps.some((step) => step.id === id), `${kind}/${id}`);
      }
    }
    assert.match(workspace, /function TutorialAnalysisWorkspace/);
    assert.match(workspace, /data-tutorial-target="chat-composer"/);
    assert.match(workspace, /data-tutorial-target="restart-guidance"/);
    assert.match(workspace, /tutorialActivatePathTarget/);
    assert.doesNotMatch(workspace, /<CurrentTaskCard task=\{workflow\.nextTask\}/);
    const analysis = readFileSync('src/components/analyses/analysis-chat-view.tsx', 'utf8');
    assert.match(analysis, /\['chat', 'Análise'\]/);
    assert.doesNotMatch(analysis, /<CurrentTaskCard task=\{workflow\.nextTask\}/);
    assert.match(analysis, /email-draft\/download/);
    assert.doesNotMatch(analysis, /window\.confirm\(surfaces\.approve/);
  });

  it('keeps list geometry responsive and the application shell as the only viewport boundary', () => {
    const home = readFileSync('src/components/home/home-view.tsx', 'utf8');
    const theme = readFileSync('src/components/app/theme-toggle.tsx', 'utf8');
    const frame = readFileSync('src/components/app/app-frame.tsx', 'utf8');
    const css = readFileSync('src/app/globals.css', 'utf8');
    assert.match(home, /w-full table-fixed/);
    assert.match(home, /max-h-full overflow-y-auto/);
    assert.doesNotMatch(home, /min-w-\[880px\]|overflow-auto/);
    assert.match(theme, /h-5 w-5 shrink-0/);
    assert.match(frame, /fixed inset-0[\s\S]*?overflow-clip/);
    assert.match(css, /html,\s*body\s*\{[\s\S]*?height: 100%;[\s\S]*?overflow: hidden;/);
  });

  it('opens complete contextual topics in a centered popup and restores invocation focus', () => {
    const provider = readFileSync('src/components/help/help-provider.tsx', 'utf8');
    assert.match(provider, /role="dialog"/);
    assert.match(provider, /place-items-center/);
    assert.match(provider, /<HelpTopicSection/);
    assert.match(provider, /invocation\?\.focus\(\)/);
    assert.doesNotMatch(provider, /router\.push|window\.location|<SlideOver/);
  });
});
