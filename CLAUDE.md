# legal-assistant instructions

## Scope

These instructions apply to the entire `legal-assistant` repository.

## Repository role

The **Barraqueiro Legal Assistant**: a Next.js (App Router, `output:'standalone'`) web app
for the Legal & Compliance office of Grupo Barraqueiro — controlled production of document
summaries and revisions, with app-validated citations, human confirmation gates, and
immutable versioning. `README.md` is the product description and stays in sync with what is
built; the phased plan lives with the Naten team.

## The single-repo rule (Naten requirement — hard)

**The app functions only on code within this repository, including the AI.** There is no
external agent service and no cross-repo import — patterns from `natenai/helpdesk-app` and
`natenai/agent` are PORTED (copied and adapted), never imported. The only external services
the app talks to are **Microsoft Graph** (the client's own M365 tenant) and the **model
API** (OpenAI). Vendored files under `src/lib/server/ai/vendor/` carry a header naming
their origin file and date; keep their diffs against the origin minimal so upstream fixes
are easy to carry over.

- **Own env namespace.** Every environment variable is `LEGAL_*`. See `.env.example`.
- **Own data root.** All persistence lives under `LEGAL_DATA_DIR` (default `/data-home`
  in-container): SQLite DB, file cache, OAuth in-flight state.
- **Own cookie.** The session cookie is `__legal_session`.

## AI layer doctrine

- **The AI is a module of this app** (`src/lib/server/ai/`), not a service. Every
  judgemental stage is one bounded, synchronous, STRUCTURED call through
  `aiStructured()` — a single forced function tool whose parameters are the stage's JSON
  Schema, validated app-side (`validate.ts`) before anyone sees the result, one retry with
  the validation errors appended. No agent loop, no app tools, no web access.
- **Provider: ChatGPT Plus/Pro subscription** (Luís, 2026-08-23 — "para conseguirmos usar
  as subscrições") via the vendored Codex OAuth cluster; tokens live encrypted in the
  settings table. `LEGAL_OPENAI_API_KEY` is a configuration-only fallback.
- **The grounding contract** (`contract.ts`) states the trust rules to the model; the
  validators ENFORCE them. Never rely on instructions where a validator can check.
- **Degradation is a feature.** With no ChatGPT connection and no API key the app boots,
  every AI stage reports `not_configured`, and the test suite runs entirely on that path.

## Product rules that shape the code (from the client briefing)

- **The library is the world.** The AI may only cite documents from the client's OneDrive
  library; unsupported claims render exactly
  "Informação não confirmada nos documentos selecionados" (`NOT_CONFIRMED_SENTENCE`).
- **Structured JSON before prose.** No narrative or DOCX is generated from anything that
  has not passed schema + citation validation.
- **Citations are validated by the app** against its own page-anchored text store: page
  exists, excerpt on that page, source among the documents the user confirmed.
- **Every consequential step has a human gate**; every confirmed change is a new immutable
  version; one final DOCX at a time; PDFs are regenerated (hash-checked), never reused.
- **Email can never be sent by the app** — drafts only; the Graph permission `Mail.Send`
  is never requested.
- All AI OUTPUT content is pt-PT; the codebase and UI chrome are English.

## Working guidance

- Auth-gate every API route first (`withSession` from `src/app/api/_helpers.ts`), then
  `NextResponse.json`.
- SQLite via `node:sqlite` (`src/lib/server/db.ts`): WAL PRAGMAs, idempotent migrations
  through `migrateAddColumn` or a documented rebuild, DDL as consts. Tables land in the
  phase that first uses them.
- Secrets at rest through `src/lib/server/secrets.ts` (AES-256-GCM); add every new
  credential settings key to `SECRET_SETTING_KEYS`.
- `LEGAL_FAKE_GRAPH=1` is HARNESS-ONLY: it swaps the OneDrive upload/convert layer for a
  deterministic local fake (see `graph-files.ts`) so the §17 suite runs without a tenant.
  Never set it in a real deployment.
- The design system is the Naten one (`globals.css` tokens + `ui-*` classes, Space Grotesk
  + IBM Plex Mono); register any new CSS variable in `tailwind.config.js` or its Tailwind
  class silently compiles to nothing.

## Useful commands

- Install: `npm install`
- Dev: `npm run dev`
- Build: `npm run build`
- Start (container-identical): `npm run start`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`
- Test: `npm test` (build + suite) or `npm run test:fast` (suite against existing build).
  The suite boots the built app against a throwaway data dir and drives the real API; the
  harness blanks every `LEGAL_*` var so a developer's `.env` cannot leak in.

## CI policy — checks are local, Actions is manual

GitHub Actions minutes are a limited shared budget: **neither workflow triggers on push**;
both are `workflow_dispatch` only. **The gate before pushing is local:**
`npm run typecheck && npm run lint && npm test`. Do not re-add a `push:` trigger.
