# Guided workflow, Help and tutorials plan

Agreed 2026-09-10. This is the canonical implementation plan for the Barraqueiro Legal Assistant. The session checklist is `/home/tomas/helpdesk-app/.pi/plans/plan-20260910-094837.md`; implementation belongs only to this repository.

## Product principle

The main interface tells a legal user what needs attention now, why it matters, what each choice does, and what follows. Audit history, technical provenance and alternate paths remain complete but secondary. Tutorials reproduce the real presentation and workflow contracts in an isolated sandbox and never mutate live business data or OneDrive.

## Non-negotiable boundaries

- Citations remain limited to individually confirmed Library sources and are validated against stored page text and exact excerpts.
- Unsupported values remain `not_confirmed`; rejected findings never enter generated documents.
- Extraction, Word, PDF and e-mail gates remain explicit human decisions.
- Extractions, generated documents and alternate work remain append-only/immutable.
- Semantic similarity never proves an alters/substitutes relation, and inbound relations are never inverted.
- E-mail remains a draft/download workflow; `Mail.Send` is absent.
- Reprocessing and re-transcription controls keep their existing behaviour. Opening a preview, Help topic or tutorial never triggers OCR, classification, embeddings or publication.
- Existing production analyses remain untouched until the separately approved cleanup in steps 40–41.

## Implementation steps

1. **Preserve trust and audit boundaries.** Audit the existing enforcement and keep focused regression coverage green throughout the work.
2. **Save this complete plan in the Legal Assistant repository.** Keep the implementation and its documentation in this repository.
3. **Establish acceptance journeys.** Cover relation setup; Summary and Revision; individual and whole-extraction rejection; retry; return to an earlier stage; versions; output approval; Results; contextual Help; and repeatable tutorials. A first-time legal user must complete them without engineering explanation.
4. **Define one pt-PT vocabulary.** Centralise labels for user work, findings, decisions, versions and outputs while retaining internal enums.
5. **Create a Help-context registry.** Give every analysis stage, significant decision and Library-detail tab a stable context ID, Help anchor and return contract.
6. **Implement contextual Help icons.** Use an accessible question-mark icon that redirects to the full Help page, scrolls to and highlights the relevant section, and offers a safe return link.
7. **Rebuild Help around tasks and consequences.** Organise around preparing sources, confirming relations, running each workflow, reviewing results, handling exceptions and finding outputs; add real-state troubleshooting.
8. **Make extraction Help the deepest topic.** Explain structured findings, citation validation, exclusions, legal decisions, individual rejection, whole rejection, retry and return consequences separately for Summary and Revision.
9. **Add a central next-task projection.** The workflow evaluator returns responsible actor, next action, reason, consequence, next outcome, blockers and Help context; all screens consume it.
10. **Turn analyses into a work queue.** Group work awaiting the user, work being processed and concluded work; each entry states and opens its actual next task.
11. **Simplify creation.** Normal flow is intended result, principal document, supporting documents, review/start. Templates and instructions are advanced options.
12. **Recommend confirmed relations.** Rank confirmed relations first, explain each recommendation, preserve individual selection, and keep name search for other official sources.
13. **Make Relations deliberate setup.** Explain its impact on later recommendations, default to pending work and clarify type, confidence, relevance and consequences.
14. **Add tab work-count badges.** Relations counts proposed pairs awaiting confirmation; Analyses counts distinct linked, unconcluded analyses. Hide zero and label accessibly.
15. **Keep chat but make stages action-oriented.** Show one current-task card above chronology, one primary action and a Help icon on the message where the concept arises.
16. **Improve analysis Details.** Keep configuration/sources and add a clean Results/version area for extraction data, Word, PDF and e-mail; move technical audit detail behind disclosure.
17. **Build a full review workspace.** Replace the extraction drawer; default to work requiring attention; add grouping, filtering, search, progress and adjacent source preview; approve only here.
18. **Clarify rejected findings.** Explain exclusion and allow validated correction/retry or continued exclusion without unsupported override.
19. **Add whole-extraction rejection.** `Reject and redo` records a reason, preserves the rejected artifact, generates nothing from it and restarts through the workflow contract.
20. **Explain every return.** Offer only valid destinations and state what is retained, superseded, repeated and audited.
21. **Replace Caminhos with Versões e histórico.** Hide branches for linear work, name alternatives by cause, show readable milestones and keep the technical event log secondary.
22. **Make output approval sequential.** Extraction leads to Word, Word approval to PDF, PDF approval to e-mail. Keep approvals on previews and explain that the app never sends mail.
23. **Correct DOCX preview fallback.** Diagnose Graph conversion/cache failures, prefer original-document PDF rendition, label extracted text as fallback and never reprocess solely for preview.
24. **Improve Library without replacing it.** Keep official/template structure, rename `3. Documentos gerados` to `3. Resultados`, recognise legacy paths and make the migration idempotent.
25. **Tailor each Library kind.** Official documents emphasise readiness/type/date/relations; templates purpose and Original/Editado; Results producing analysis/output/approval/version.
26. **Improve document detail.** Preserve tabs/actions and reprocessing controls; prioritise preview and essential facts; move hashes/extractor internals to technical details; add contextual Help.
27. **Inventory tutorial source documents.** Shortlist a small set of existing official documents covering a principal document, confirmed relations, Summary findings, Revision decisions and original DOCX preview. Report exact IDs/roles before snapshotting.
28. **Create an immutable internal tutorial dataset.** Copy only approved binaries, metadata, page text, renditions, relation evidence, templates and deterministic outputs under `LEGAL_DATA_DIR`, outside Git/image, with hashes/provenance.
29. **Isolate the tutorial environment.** Separate repositories/routes/session state; no writes to live analyses, relations, messages, versions, conversions, Library tables or OneDrive; no production AI/Graph mutations.
30. **Reuse real contracts in the sandbox.** Drive shared workflow labels, Help contexts and presentation components through a tutorial adapter and contract-test parity.
31. **Add a Tutoriais top-nav entry.** Catalogue Biblioteca, Resumo documental and Revisão / Atualização with start/continue/restart and progress; also link from Help and suitable empty states.
32. **Make tutorials replayable.** Unlimited runs with Back/Next/Skip/Exit/Resume/Restart; current run is separate from completion history; Help round-trips preserve progress; no consequential live action is automated.
33. **Build the Library tutorial.** Official document first, including every relevant tab and relation setup; then template; then internal Results. Teach Help icons and work badges.
34. **Build the Summary tutorial.** Use internal sources/confirmed relations; review valid/rejected/corrected findings; demonstrate approve/reject extraction; review internal Word/PDF/e-mail; finish in internal Results.
35. **Build the Revision tutorial.** Explain supporting sources, matrix/legal decisions, rejected lines, retry and return; review internal outputs; finish in internal Results.
36. **Make sandbox status unmistakable.** Persistent `Tutorial — nada aqui altera os seus documentos` banner, clear exit, route distinction and no mixing with live counts/lists.
37. **Prototype difficult interactions first.** Validate Help round-trip/highlight, badges, extraction rejection, returns, versions/history and tutorial replay/isolation with an unfamiliar legal user.
38. **Implement in coordinated slices.** Contracts/Help; wizard/relations/badges; review/non-linear workflow; Details/approvals/history; previews/Library; sandbox/tutorials.
39. **Verify functionality and isolation.** Full local gate plus browser journeys; assert live DB row counts/hashes and fake/real OneDrive remain unchanged across complete tutorial runs.
40. **Prepare a cleanup inventory.** Dry-run every analysis and dependent DB/OneDrive artifact. Proposed scope removes analyses and outputs exclusive to them while preserving official documents, templates, settings, users, confirmed relations and tutorial fixtures. Take a fresh backup and obtain explicit scope confirmation.
41. **Release and establish the baseline.** Deploy and verify first; perform only approved cleanup; prove official/template/relation integrity and empty live Results; run all tutorials repeatedly and prove they create no live work.

## Delivery and validation

Each implementation slice receives focused unit/API/browser tests. Before push: `npm run typecheck && npm run lint && npm test`. Production release is backup-first and observation-based. Cleanup is never bundled implicitly with deployment and requires a fresh dry-run plus explicit approval of exact IDs and files.
