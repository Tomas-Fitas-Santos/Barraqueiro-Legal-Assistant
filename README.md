# Barraqueiro Legal Assistant

A web application for the Legal & Compliance office of **Grupo Barraqueiro** (a Portuguese
transport group). It helps one legal professional produce two kinds of controlled documents —
**summaries** of internal documents and **revisions** of documents that need updating — using
AI that is only allowed to cite the company's own document library. It is **not a chatbot**:
it is a document production tool with strict traceability, human approval gates, and version
control at every step.

> **The one rule that shapes everything:** the AI may never state anything it cannot point to
> in a real document, on a real page, held in the client's own library. If the documents
> don't answer a question, the app says so explicitly — it never fills the gap with outside
> knowledge or guesses.

---

## 1. What the client asked for

Barraqueiro's Legal & Compliance office maintains a large set of internal documents: codes of
conduct, corruption-risk prevention plans (PPRC), internal notes, policies, and similar. Two
recurring tasks consume significant time and carry real risk when done under pressure:

1. **Understanding a document quickly and reliably.** "What obligations, deadlines,
   responsibilities and sanctions does this document establish?" — answered in a structured,
   verifiable way, not as loose prose.
2. **Revising a document when the world around it changes.** Internal documents reference
   and depend on each other. When one changes (or a periodic review is due, e.g. a
   three-yearly review of the PPRC), the office needs to know *exactly* what differs between
   the current document and the documents related to it, and to produce an updated draft —
   without losing obligations, deadlines or references along the way.

Because this is legal work, the client's requirements are strict:

- Every statement must be **traceable to a specific document, version and page**, with the
  supporting excerpt shown.
- The AI must **never invent** content. Missing information must be flagged with a fixed
  sentence — *"Informação não confirmada nos documentos selecionados"* ("Information not
  confirmed in the selected documents") — never papered over.
- A human confirms every consequential step: which related documents count, which proposed
  changes are accepted, whether the final PDF is approved for sending.
- Every accepted change produces a **new immutable version** — nothing is edited in place,
  history is never lost.
- The client's briefing closes with **zero-tolerance acceptance criteria**: a fabricated
  citation, a stale PDF, or an email draft without an approved PDF are outright failures.

## 2. What the app does about it

The app offers two analysis types, wrapped in the same trust machinery:

| Analysis type | What it produces |
|---|---|
| **Document Summary** (*Resumo documental*) | A structured extraction from one main document: obligations, deadlines, responsibilities, sanctions, references — each item citing document, page and excerpt, each marked by evidence quality, with AI suggestions visibly separated from documented facts. |
| **Revision / Update** (*Revisão/Atualização*) | A **comparative matrix** between the main document and the related documents the user confirmed: what each related document says, how it differs, what change is proposed, and whether the point requires a legal decision by the user. Only after the matrix is reviewed does drafting begin. |

Four guarantees apply to both:

1. **Citations are validated by the app, not trusted from the AI.** The app keeps its own
   page-by-page text of every document. For every claim the AI makes, the app checks: does
   that page exist? Is the quoted excerpt really on it? Is the source among the documents the
   user confirmed? Any obligation or deadline without a source is rejected.
2. **Gaps are declared, never filled.** Anything the library cannot support renders the
   fixed "not confirmed" sentence.
3. **Humans gate the process.** Related documents are confirmed one by one before generation
   starts. In the revision chat, changes that would remove obligations, deadlines,
   references or sources — or would turn a documented fact into a recommendation — require
   explicit confirmation.
4. **Versions are immutable.** Every confirmed change creates a new version. There is
   exactly one "final" Word document at a time, and its PDF is regenerated whenever the
   Word file changes — a stale PDF can never be sent.

## 3. Features

### Home: the process table
The first screen after login: a table of every analysis ever run — its type, main document,
current state, version count and last activity — where each row opens the full trail of that
process (versions, confirmations, gate decisions, sync events). The **New analysis** button
lives on this page and asks one question first: **Document Summary** or **Revision/Update**.
*Client need this serves:* the history requirement — the office sees everything that was
done at a glance, and every new piece of work starts from the same place.

### Library (*Biblioteca*)
The document collection, synchronized from the client's own **OneDrive** folder. The app
keeps it current automatically (on login and periodically) and on demand ("Sync now"). Each
document shows its metadata (type, dates, status), which the user can correct. When a new
document arrives that may affect an existing analysis, that analysis is flagged
"Potentially affected" — it is never silently regenerated.
*Client need this serves:* the documents stay where the client already keeps them, and the
app always works from the current set.

The library is organised into three folders, created by the app in the client's own OneDrive:

| Folder | What lives there |
|---|---|
| `1. Documentos oficiais Barraqueiro` | The client's source material. New uploads land here, and anything that predates the reorganisation is moved here once, from *Arrumar a biblioteca* (`/library/migracao`) — a reviewable, resumable move that preserves every OneDrive item id, so nothing re-ingests and no citation breaks. |
| `2. Templates` | The Word templates that format the generated documents, one subfolder per workflow. The app publishes its own there; a `.docx` the client adds is checked for the required placeholders and becomes selectable in the New analysis wizard, with the reason shown if it cannot be filled. |
| `3. Documentos gerados` | What the app produced, one folder per analysis under its workflow: the Word document, the final PDF, and a JSON export carrying every extracted statement with its citation and its accept/reject decision. |

**Formats the library reads.** Any file is accepted — a client's OneDrive holds anything, and
a document with no text still belongs in the library. These are the ones it can actually read,
meaning the text becomes extractable, previewable and citable to a document and a page:

| Format | How |
|---|---|
| PDF with a text layer | Read directly. |
| Scanned PDF | Each thin page is rasterized and transcribed; with AI off the page is honestly marked as awaiting transcription. |
| Word / Office | Converted to PDF in the client's tenant via Microsoft Graph. |
| JPG, JPEG, PNG | Wrapped into a one-page PDF in-process — EXIF rotation applied, transparency flattened — and then read like a scan. |
| MSG, EML | The headers and body become a citable document, **and each attachment becomes a library document of its own**, so a contract attached to a covering note is analysable. |

Anything else is kept and labelled *Sem leitura*, with a message naming the formats that are
read. Everything except the Office conversion happens inside the app: images and e-mails need
neither OneDrive nor the AI to become readable.

### Related documents (*Documentos relacionados*)
For a chosen main document, the app proposes documents that relate to it, each labelled with
one of 13 relationship types (complements, alters, replaces, regulates, …). Similarity alone
is never allowed to conclude the strong claims ("alters", "replaces"). The user confirms or
rejects each proposal individually — **only confirmed documents can ever be cited**.
*Client need this serves:* revisions consider everything relevant, and nothing the user
didn't approve.

### New analysis (*Nova análise*)
Where an analysis starts: pick the type (Summary or Revision), the main document, and
confirm the related set. The analysis then moves through a visible state machine (queued →
processing → ready for review → …) so it's always clear what the app is doing and what it is
waiting on.
*Client need this serves:* a controlled, repeatable process instead of an open-ended chat.

### Document in preparation (*Documento em preparação*)
A three-column workspace for the draft being produced: the structured analysis (every claim
with its citations), the generated narrative document, and the sources. Word documents are
generated from **approved templates** (two initial templates, held in a registry) — a
template change never silently mutates documents already generated.
*Client need this serves:* the draft is reviewed next to its evidence, not in isolation.

### Revision chat
The user refines the draft conversationally — but this chat has rules. Every requested
change is assessed for impact; anything that removes obligations, deadlines, references or
sources, or converts facts into recommendations, triggers a confirmation gate. Each
**confirmed** change becomes a new immutable version.
*Client need this serves:* the convenience of "just ask for the change", with none of the
silent-drift risk.

### Versions, final document and PDF
One final Word document at a time. The PDF is produced from that exact file via Microsoft's
own conversion, its name carries the version, and it is invalidated the moment the Word file
changes (verified by content hash). The user explicitly approves the PDF.
*Client need this serves:* what gets sent is provably what was approved.

### Email draft
Enabled **only** when three things are true: there is a final Word document, its PDF has
been generated from it, and the user approved that PDF. The draft attaches the PDF (never
the Word file by default). Optionally the draft can be created directly in the user's
Outlook drafts folder. The app can **never send email** — drafting is the ceiling.
*Client need this serves:* fast dispatch with no way to send the wrong file.

### History & states
Every analysis keeps its full trail: versions, confirmations, gate decisions, sync events.
The states of documents, analyses and conversions are first-class and visible.
*Client need this serves:* auditability — a legal office must be able to show its work.

## 4. How it all works together

```
 OneDrive (client's own Microsoft 365)
      │  sync (delta — only changes are fetched)
      ▼
 ┌────────────────────────── the app ──────────────────────────┐
 │ 1. Ingestion: fingerprint (SHA-256) → page-by-page text     │
 │    extraction → OCR for scanned PDFs → classification →     │
 │    metadata → page-anchored segments → search index         │
 │ 2. Relations: proposals labelled by type, user confirms     │
 │ 3. Analysis: AI run produces STRUCTURED JSON first          │
 │ 4. Validation: schema + every citation checked by the app   │
 │ 5. Drafting: narrative + Word doc from approved templates   │
 │ 6. Revision chat: gated changes, new version each time      │
 │ 7. Final → PDF (regenerated, hash-checked) → email draft    │
 └─────────────────────────────────────────────────────────────┘
```

### Every workflow is a deterministic, gated pipeline

Neither workflow is a free-running AI process: each is a **fixed sequence of stages**, and
the workflow only advances when the current stage completes — or, at a gate, when the user
approves. Each stage is one of three kinds (some combine two):

- **App** — deterministic code: hashing, state machines, validation, document assembly,
  Microsoft Graph calls. Same input, same output, every time.
- **AI** — a model call made by the app itself, always returning structured output that
  the app re-validates before accepting. The AI never advances the workflow by itself.
- **Gate** — the workflow stops until the user decides. No gate is ever skipped or
  auto-approved.

**Document Summary, stage by stage**

| # | Stage | Performed by | User gate |
|---|---|---|---|
| 1 | Library sync + ingestion (hash, per-page text, OCR, index) | App, AI assists classification | metadata is user-correctable |
| 2 | Start analysis: choose the main document | User | — |
| 3 | Structured extraction (obligations, deadlines, … as JSON) | AI | — |
| 4 | Schema + citation validation | App | — (fabrications rejected automatically) |
| 5 | Narrative + Word document from an approved template | AI narrative, App assembly | ✔ review in the 3-column workspace |
| 6 | Refinement via revision chat | AI proposes, App assesses impact | ✔ impactful changes confirmed one by one; each confirmed change = new version |
| 7 | Mark final → PDF conversion (hash-checked) | App (Microsoft Graph) | ✔ mark final · ✔ approve the PDF |
| 8 | Email draft (PDF attached, never the Word file) | App | enabled only after every gate above |

**Revision / Update, stage by stage**

| # | Stage | Performed by | User gate |
|---|---|---|---|
| 1 | Library sync + ingestion | App, AI assists classification | metadata is user-correctable |
| 2 | Start analysis: choose the main document | User | — |
| 3 | Related-document proposals (13 relationship types) | AI + deterministic signals | ✔ each document confirmed or rejected individually |
| 4 | Comparative matrix across the confirmed documents | AI | — |
| 5 | Matrix validation (citations only from confirmed documents) | App | ✔ review the matrix; every line marked "requires legal decision" is decided here, before any prose exists |
| 6 | Updated draft from the accepted matrix lines only | AI narrative, App assembly | ✔ review in the workspace |
| 7 | Refinement via revision chat | AI proposes, App assesses impact | ✔ same per-change confirmation, one version per change |
| 8 | Mark final → PDF → email draft | App | ✔ mark final · ✔ approve the PDF |

The two workflows share their head (stages 1–2) and their tail (workspace review, revision
chat, final/PDF/email) — the tail is built once and both use it. What differs is the middle:
what the AI is asked to produce, and which gates guard it.

The key sequencing rule: **structured data before prose**. The AI first produces JSON that
must pass the app's schema and citation validation; only then is the human-readable document
generated from it. Prose is downstream of verified facts, never the other way round.

Scanned documents matter here: two of the client's core documents (the PPRC and the Código
de Conduta) are scanned PDFs, so OCR with correct page anchoring is a mandatory, tested part
of the pipeline — not an afterthought.

## 5. Architecture

One application, one repository — with a deliberately sharp internal split between what is
deterministic and what is judgemental:

```
┌───────────────────────────────────────────────────────────────────┐
│              legal-assistant (this repo — ALL the code)           │
│                                                                   │
│  Deterministic core                  AI layer (in-repo module)    │
│  states, versions, hashes,    ───▶   model calls for the          │
│  citation validation, gates,         judgemental stages:          │
│  OneDrive/Graph I/O, history  ◀───   classification, relation     │
│                                      proposals, extraction JSON,  │
│                                      narrative, revision edits    │
└──────────────────────────────────┬────────────────────────────────┘
                                   │  the app's only external calls
                                   ▼
             Microsoft Graph (client's own M365)  ·  model API (Claude)
```

- The **deterministic core** owns everything that must be exact: state machines, version
  chains, file hashes, citation checks, Microsoft 365 integration, confirmation gates.
- The **AI layer** is a module of this same codebase. Each judgemental stage is a direct
  call to the model API, carrying the grounded-extraction contract (cite document + page +
  excerpt, mark evidence quality, never fill gaps) and a JSON Schema the response must
  satisfy. The model is given **only** the documents the app stages for that call — it has
  no tools, no web access, no way to reach anything else. The library really is the AI's
  whole world.
- The core **never trusts** what a model call returns: everything is re-validated against
  the app's own page-anchored text store before it is accepted.

**All code the app runs lives in this repository** — UI, pipeline, validators, and the AI
layer itself (a Naten requirement). There is no external agent service. The only things the
app talks to are Microsoft Graph, in the client's own tenant, and the model API.

## 6. Where data lives

| Data | Where | Notes |
|---|---|---|
| The documents themselves | **Barraqueiro's own Microsoft 365** (OneDrive) | The library stays in the client's tenant; the app syncs from it. Word→PDF conversion and optional Outlook drafts also happen in the client's tenant via Microsoft Graph. |
| App database (metadata, page text, segments, analyses, versions, states, history) | SQLite on Naten's server (Hetzner) | Private volume, backed up like Naten's other apps. |
| AI processing | Inside the app, on the same server | Each AI stage is sent only the documents it needs for that call; nothing is stored outside the app's own database and files. |
| Email | Never sent by the app | Drafts only; sending is always a human act in the user's own mail client. |

No document content goes to any external service other than the model API used by the
app's AI layer.

## 7. Deployment

- **Testing URL:** `https://barraqueiro-legal.naten.ai`
- Runs on Naten's existing Hetzner server as a single container behind the shared edge
  proxy — the whole app, AI layer included, is one deployable built from this repo.
- Access to the client's Microsoft 365 uses an app registration in **Barraqueiro's tenant**
  with delegated permissions: `Files.ReadWrite` for the library, and optionally
  `Mail.ReadWrite` for Outlook drafts. `Mail.Send` is never requested.

## 8. Explicitly out of scope (MVP)

This list comes from the client's own briefing (§3) — the boundary is part of what was
agreed, not our judgement. The items are of two different kinds:

**Deferred** — not in the MVP, natural later additions if the client asks for them:

- External legal sources (official journals, case law)
- Multiple users / permission levels
- Teams or Excel integrations
- Analyses running in parallel

The app is built so these can be added without rework (for example, nothing hard-codes the
single user into the data model) — but they are not built until asked for.

**Excluded by design** — these contradict the product's trust model, not the schedule, and
stay out even where they would be convenient:

- **Automatic email sending.** The app can only ever create drafts; the `Mail.Send`
  permission is never requested, so sending is impossible by construction.
- **Automatic regeneration of affected analyses.** When a new document may affect an
  existing analysis, the app flags it "Potentially affected" — the user decides whether to
  regenerate. Nothing legal is ever rewritten silently.
- **A generic legal chatbot.** The revision chat exists, but it is a gated editing tool
  scoped to one document in preparation — not an open question-answering surface.

## 9. Project status & roadmap

**Status: MVP feature-complete.** All phases (0–9) delivered — phase 9 rebuilt the
analysis surface as a chat-driven workflow (every deterministic step, gate and document
in one conversation; side-panel previews; every citation clickable to its source page;
a Histórico tab with track-back forking and the v1a/v2a/v1b version nomenclature) (scaffold + AI layer; Microsoft Graph +
OneDrive library; ingestion pipeline with page-anchored text, OCR and full-text index;
documental relations with the 13-type taxonomy and per-document confirmation; the two
analysis workflows with the briefing state machine, §10 schemas and §11 citation
validators; the document workspace with immutable versions, the two-template registry
and app-built Anexo de fontes; the revision chat with the §13 confirmation gates and the
app-side impact cross-check; the final/PDF/email chain with hash-bound conversions and
the §17 zero-tolerance acceptance suite; nightly backups and the client switch-over
procedure). The full acceptance run — a revisão trienal of the PPRC with the Código de
Conduta confirmed as related, walked from relation proposal to the approved-PDF email
draft — completed live on the deployed instance. Remaining before client delivery:
Barraqueiro tenant credentials (request drafted in docs/), template visual adjustments
with the client, and human visual validation of generated PDFs (§17). Phases:

| # | Deliverable |
|---|---|
| 0 | Repo scaffold (Next.js, SQLite, test harness) + the in-repo AI layer: model-API client, grounded-extraction contract, JSON Schemas for both analysis types |
| 1 | Microsoft Graph client + OneDrive library with delta sync + Library UI |
| 2 | Ingestion pipeline: hashing, per-page extraction, OCR (PPRC + Código de Conduta as mandatory fixtures), classification, segments, index |
| 3 | Relations: typed proposals + per-document confirmation UI |
| 4 | Analyses: both types, structured-JSON runs, app-side schema + citation validators, comparative matrix |
| 5 | Document in preparation: 3-column workspace, template registry, immutable version chain |
| 6 | Revision chat with impact assessment and confirmation gates |
| 7 | Final/PDF/email rules + the zero-tolerance acceptance test suite |
| 8 | History & States surfaces, hardening, deployment |

The client's acceptance criteria (briefing §17) are implemented as an automated test suite —
including a "poisoned run" test proving that a fabricated citation is rejected by the app.
