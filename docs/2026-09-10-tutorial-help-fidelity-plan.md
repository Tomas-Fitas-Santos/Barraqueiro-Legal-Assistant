# Tutorial fidelity, contextual Help and terminology plan

Agreed direction drafted 2026-09-10 after a Playwright audit of the production application at commit `26b52e69ee7d44f2bc27d92f56a55aa88f67bb36`.

This plan supplements `2026-09-10-usability-tutorial-plan.md`. Where the earlier plan calls for simulated tutorial presentation or contextual navigation to the full Help page, this plan supersedes it: tutorials render the real application components against isolated data, and contextual Help opens in place.

## Outcome

Deliver three complete training versions of the application—Biblioteca, Resumo documental and Revisão / Atualização—without maintaining three copies of the UI. The live app and all three tutorials use the same visual components. Tutorials supply deterministic private data and tutorial-only actions; live APIs, Graph, AI and business tables remain unreachable from tutorial mode.

Remove the dark tutorial filter. Highlight only the control or information region relevant to the current step. Guidance never covers application content. Reading steps and action steps are distinct.

Use one pt-PT product vocabulary everywhere. The product term is **Template**, not “Modelo”, whenever the text refers to document, e-mail or extraction templates. “Modelo” remains valid only for AI models in Settings.

Contextual Help opens a scrollable in-app container containing the complete relevant topic. It does not navigate away from the current screen. The top-level Help page remains available as the complete guide and receives a usable, independently scrollable index.

## Production audit findings

The audit followed the real authenticated production paths at 1440×900 and 1280×620 and inspected all three tutorial journeys.

### Help

- A contextual Help button on an official document navigated from the document to `/ajuda?context=library.official.summary&returnTo=…#documento-resumo`; it did not preserve the work surface in view.
- The Help index declared `overflow-y:auto`, but its container had no constrained height. At 1440×900 its bottom was at y=1158. At 1280×620 the last entries were not visible and the index had no internal scroll range (`clientHeight === scrollHeight === 950`).
- The page presents a long stack of similarly weighted cards and does not use the existing section groups to make the guide scannable.
- Runtime text on the Help page contained four occurrences of “Modelo/Modelos” and no “Template/Templates”.
- The highlighted contextual section worked, but it displaced the user from the task and showed adjacent topics that were not part of the question.

Evidence captured during the audit:

- `/tmp/legal-audit-help-desktop.png`
- `/tmp/legal-audit-help-short.png`
- `/tmp/legal-audit-help-context.png`

### Tutorials

- The dark veil suppresses labels, metadata, citations and neighbouring controls during steps that explicitly ask the learner to read them.
- The guidance card does not overlap the outlined target, but it frequently covers surrounding information needed to understand that target.
- The current tutorial workspace duplicates the application shell inside the real application shell.
- The tutorial Library root is three large cards; the real Library root is the production file table with upload, folder, search, sort, selection and row menus.
- Official-document, Template and Result details are hand-built approximations rather than `DocumentDetailView`.
- The tutorial Template editor is a simplified form rather than the production editor and preview.
- Tutorial analysis queue, wizard, overview, review, Word, PDF, e-mail and Results screens are separate handcrafted components. Their columns, controls, spacing, tabs, status language and secondary information differ from the real screens.
- The tutorial queue shows one simplified row while the real queue uses the complete work-queue structure.
- Current tutorial definitions mix “Template” and “modelo”; the real wizard still contains “Modelo Word” and “Modelo standard do fluxo”.

Evidence captured during the audit includes:

- `/tmp/legal-audit-actual-queue.png` and `/tmp/legal-audit-tutorial-summary-01.png`
- `/tmp/legal-audit-actual-library.png` and `/tmp/legal-audit-tutorial-library-02.png`
- `/tmp/legal-audit-actual-official-detail.png`
- `/tmp/legal-audit-actual-template-detail.png`
- `/tmp/legal-audit-actual-result-detail.png`
- `/tmp/legal-audit-tutorial-summary-07.png`
- `/tmp/legal-audit-tutorial-revision-07.png`

The audit created three isolated tutorial runs and removed those exact run IDs afterward. It did not modify analyses, conversions, fixtures, Library data or OneDrive. Other user-created runs that appeared during the audit were preserved.

## Architecture decision: one UI, two data/action adapters

Do not create three copied application implementations. Copies would immediately create four sources of truth: live, Biblioteca training, Resumo training and Revisão training.

Instead:

1. Extract data loading, mutations and navigation from each applicable page into a typed adapter interface.
2. Keep the current production rendering as the single visual component tree.
3. Implement a `LiveAppAdapter` that preserves current API and routing behaviour.
4. Implement a `TutorialAppAdapter` that reads only the immutable tutorial scenario and writes only `tutorial_runs.demo_state_json`.
5. Define three versioned scenarios over that adapter: Biblioteca, Resumo documental and Revisão / Atualização.
6. Render the normal application frame once. Tutorial mode adds only a persistent training banner, progress controls and a non-overlapping coach area.

The adapter boundary must cover reads as well as actions. A tutorial component must never issue a normal `/api/analyses`, `/api/library`, `/api/templates`, Graph or AI request and rely on click blocking for safety.

### Shared surfaces

The tutorial routes must directly reuse the production surfaces they teach:

- `HomeView` work queue.
- `LibraryView`, its real folder table and row controls.
- `DocumentDetailView` for official documents, Templates and Results.
- The shared `PreviewDrawer` and `DocumentPreview`.
- The production Template editors and their A4 preview.
- `NewAnalysisWizard` for type, principal source, supporting sources and review.
- The production analysis current-task, Details and Versions/history surfaces.
- `ExtractionReview` and `ExtractionItemCard` for Summary and Revision decisions.
- `OutputSequence` and the real Word, PDF and e-mail approval presentation.

Components that currently fetch internally are split into a controller and a presentational view, or moved onto the shared adapter hook. The live controller remains behaviourally unchanged.

### Tutorial route and navigation model

- Use a tutorial route namespace that carries `kind`, `runId` and the current in-app location.
- The actual top navigation component renders once and reflects the current tutorial location.
- Links and back navigation are resolved by a tutorial router; they never escape into live pages unless the user explicitly chooses **Sair do tutorial**.
- Existing run progress remains server-owned, resumable and per-user.
- Add `scenarioVersion` and stable step IDs. Provide an explicit mapping from current runs to the new scenario steps so existing runs resume safely; if a state cannot be mapped, offer a clearly explained restart rather than silently resetting it.

## Tutorial guidance without obstruction

### Remove the mask and pop-ups

- Delete the full-canvas dark overlay.
- Delete floating instructional cards from inside the application canvas.
- Add a `TutorialCoachBar` outside the application viewport, between tutorial progress and the rendered app surface. It uses full available width and never overlays the app.
- The coach bar contains the step title, instruction, consequence, Back/Next and progress. It can wrap or scroll internally on short screens without covering the application.
- Keep the application viewport full width so A4 previews retain production geometry.

### Highlighting

- A target receives only a high-contrast outline, offset and optional marker; its fill, gradient, text and disabled state remain exactly as rendered by the real app.
- Scroll the target into view with space reserved for the coach bar.
- Preview drawers, dialogs and menus open with their production positioning. Highlight the relevant control or region inside them; do not turn the entire drawer into a replacement tutorial screen.
- Highlight state must not change layout dimensions.

### Two explicit step types

`observe`

- Highlights a complete information region, such as provenance, citation evidence, approval state, version history or the three Library folders.
- The learner reads the real presentation and advances with **Compreendi / Seguinte** in the coach bar.
- No application click is required.

`action`

- Highlights one real control or form operation.
- Only the action(s) declared for that step can execute.
- The coach bar shows the consequence after the tutorial adapter records the simulated action, then enables Continue.

Optional `input` requirements define realistic form values and validation. They remain tutorial-only.

### Interaction confinement

- Give reusable production actions stable semantic action IDs.
- In tutorial mode, capture pointer, keyboard and form events at the application boundary.
- Permit only the current step allowlist plus explicit tutorial controls such as Exit and Help.
- Prevent unlisted links, menus and shortcuts without changing their visual rendering; explain on interaction that the control is outside the current training step.
- The adapter remains the security boundary even if the UI guard fails.

## Versioned tutorial scenarios

### Biblioteca

Use the real Library table and navigate its actual folder rows.

1. Read the three root folder rows and their real columns.
2. Open Documentos oficiais, search and open the immutable source.
3. Read the real official-document Summary, Metadata, Relations, Analyses and Text tabs.
4. Open the real preview drawer using the immutable binary/rendition.
5. Decide a proposed relation through the real relation presentation.
6. Return to the root and open Templates.
7. Open actual DOCX, EML and JSON Template details so their purpose is learned from the production presentation.
8. Open the real in-app editor for an app-owned Template and perform an isolated simple edit with the real preview.
9. Demonstrate an externally authored DOCX appearing in the correct workflow subfolder, its validation state and selection availability. No real upload occurs.
10. Open Results, then real DOCX/PDF/JSON/e-mail rows and their production detail/provenance.
11. Follow the producing analysis through the tutorial router.

### Resumo documental

1. Use the real work queue and creation wizard.
2. Choose the real immutable principal source and individually confirm supporting sources.
3. Review the real start summary and current-task presentation.
4. Use the complete Summary extraction workspace: accepted, attention and excluded findings, citations and adjacent source preview.
5. Include an observation step for how evidence is presented and action steps for decisions.
6. Demonstrate whole-extraction rejection and replacement as an isolated alternative attempt.
7. Use real Details and Versions/history.
8. Review and approve the real Word presentation, real PDF preview and real e-mail draft sequence.
9. Finish on the real Result detail and provenance link.

### Revisão / Atualização

1. Use the same real queue and wizard with Revision selected.
2. Confirm the comparison set individually.
3. Use the complete Revision extraction workspace and real legal-decision controls.
4. Distinguish pending decision, rejected line, excluded evidence and not-applicable state in observation steps.
5. Exercise rejection reason, replacement attempt and return-to-stage confirmation through tutorial-only actions rendered by real components.
6. Use real Details, Versions/history, Word, PDF, e-mail and Result surfaces.

## Contextual Help redesign

### One content source

- Extract each Help topic from `HelpView` into a structured `HELP_TOPICS` registry keyed by `HelpContextId`.
- A topic owns its canonical title, short label, group and complete renderable body.
- The full Help page and contextual container render the same topic component. No copied short explanations.

### In-place Help container

- Replace `ContextHelpLink` with an accessible `ContextHelpButton`.
- Add a provider at the application frame level that opens the requested topic in the shared `SlideOver`.
- Show the whole topic, not a clipped excerpt and not the full Help catalogue.
- Give header and close control fixed positions; give the topic body `min-height:0` and `overflow-y:auto`.
- Support Escape, focus trap, focus restoration and an accessible title/description.
- Opening and closing Help does not alter the current URL, tab, wizard state, tutorial step, preview or unsaved form state.
- Contextual Help inside a tutorial uses the same container and topic content.
- Keep `/ajuda?context=…#…` compatible for existing bookmarks, but application Help buttons no longer navigate there.

### Full Help page

- Use the existing groups—Começar, Preparar, Analisar, Aprovar, Consultar and Resolver—in the visible index.
- Add topic search over titles and plain-language keywords.
- Constrain the Help workspace to the height available below the page header.
- Make index and article independent scroll regions with `min-height:0`, `height:100%` and actual overflow bounds.
- Keep the active topic visible in the index when article scrolling changes it.
- At narrow widths, replace the fixed index with a searchable topic selector/drawer.
- Reduce repeated card weight and improve hierarchy: compact section headings, readable line length, consistent callouts and less empty chrome.

## Terminology contract

Centralise user-facing product nouns in `product-language.ts` and consume them in live views, Help and tutorials.

Canonical terms:

- **Template / Templates**
- **Template de documento**
- **Template de e-mail**
- **Template de campos**
- **Template Word** and **Template standard do fluxo**
- **Documentos oficiais**
- **Resultados**
- **Resumo documental**
- **Revisão / Atualização**
- **Relações**
- **Versões e histórico**

Rules:

- Do not use “Modelo/Modelos” for a Template anywhere in user-facing text.
- Keep “modelo” only when referring to an AI model in Settings or diagnostics.
- Keep internal enums, database values, route names and engineering comments unchanged where they are not user-facing.
- Reconcile status mismatches such as tutorial “Disponível” versus live “Indexado” through the same presentation helpers.
- Derive Help labels and tutorial text from the canonical vocabulary where practical.
- Preserve legacy Help anchors with aliases when renaming `modelos` to `templates`.

## Delivery slices

### 1. Vocabulary and Help content foundation

- Create the canonical vocabulary and migrate live, Help and tutorial labels.
- Extract the topic registry without changing topic meaning.
- Add tests for context coverage and prohibited Template-domain terminology.

### 2. Contextual Help and Help page

- Implement the global Help container and convert every contextual Help entry point.
- Fix independent Help index/article scrolling and redesign the grouped index.
- Verify desktop, short-height, narrow and keyboard behaviour before proceeding.

### 3. Tutorial platform

- Introduce adapter, tutorial router, scenario versioning, action IDs and interaction confinement.
- Replace the mask/pop-up guide with the non-overlapping coach bar and observe/action/input step model.
- Add an adapter tripwire that fails any tutorial request to a live mutation, Graph or AI path.

### 4. Biblioteca on shared components

- Refactor and reuse Library, detail, relation, preview and Template-editor components.
- Remove their handcrafted tutorial equivalents only after browser parity passes.

### 5. Shared analysis creation and review

- Refactor and reuse work queue, wizard, current task and extraction review.
- Deliver Summary scenario first, then Revision over the same components.

### 6. Shared outputs, Details and history

- Reuse Word/PDF/e-mail, Details, Results and Versions/history surfaces.
- Complete scenario migration and remove all remaining tutorial-only visual screen clones.

### 7. Production acceptance

- Run automated isolation/parity/accessibility checks and every complete browser journey.
- Deploy exact image and repeat production browser verification.
- Do not bundle analysis cleanup or any OneDrive cleanup with this work.

## Verification gates

### Fidelity

- For every tutorial location, assert the same production component identifier renders in live and tutorial mode.
- Maintain paired Playwright screenshots at desktop and constrained height for queue, wizard, Library root, each detail kind, preview, extraction review, Details/history and each output stage.
- Compare structure and geometry with deterministic data; mask only timestamps and immutable fixture-specific values.
- Add a source-level guard against reintroducing separate tutorial `*Screen` clones for production surfaces.

### Guidance

- Assert there is no full-canvas dimming element.
- Assert highlighted controls retain computed background, text and border styles before and during highlighting.
- Assert the coach bar never intersects the application viewport.
- Assert observation steps advance without fake application actions and action steps cannot advance without their declared interaction.
- Verify every target at 1440×900, 1280×620 and 1024×768, plus keyboard-only navigation.

### Help

- Clicking every contextual Help button keeps pathname and application state unchanged.
- Every context renders exactly one complete registry topic in the container.
- Long topics scroll while the header/close control remain reachable.
- At 1280×620 the final Help index topic is reachable by scrolling.
- Focus enters the container, is trapped, closes with Escape and returns to the invoking button.

### Isolation

Before and after every full tutorial:

- Live analysis, extraction, relation, version, conversion, document and message counts/hashes are identical.
- OneDrive inventory is identical.
- No AI, Graph or live mutation endpoint was called.
- Only the current user's tutorial run state changed.

### Terminology

- Automated client-text inventory rejects “Modelo/Modelos” in Template-domain Help, tutorial and production surfaces.
- Browser journeys assert the same canonical labels in the real app, contextual Help and corresponding tutorial step.
- AI-model settings remain exempt and continue to use “modelo” correctly.

## Completion standard

This work is complete only when a learner can traverse all three tutorials through the real application UI, with only the intended controls active, no content-obscuring layer or guidance card, and no visual clone to drift. Contextual Help must answer the current question without leaving the current screen, the full Help index must be usable at constrained heights, and terminology must match across live UI, Help and tutorials.
