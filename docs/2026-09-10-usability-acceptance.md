# Usability acceptance journeys

These journeys are the acceptance contract for the 2026-09-10 guided-workflow redesign. They supplement automated correctness tests; they do not replace the legal user's judgement.

## Test participant and conditions

- A legal user who has not been briefed on the implementation vocabulary.
- Desktop viewport used in production, followed by a keyboard-only pass and a narrower viewport pass.
- No verbal hints from the observer. The product and its Help links are the available guidance.
- Throwaway data until the separately approved production cleanup and final walkthrough.

## Success standard

At every stage the participant can state: what is happening, whether they or the application act next, what the primary choice does, and what follows. A journey fails if it is completed only after an engineer explains a term, points to a hidden control, or explains the consequence of a non-linear choice.

## A. Relations as preparation

1. Open an official document with proposed relations.
2. Notice the pending-work count on Relações.
3. Open Relações and explain why confirming links improves later recommendations.
4. Distinguish decision state, confidence and relevance.
5. Confirm one pair and reject another, understanding the effect on future analysis suggestions.

## B. Summary — linear path

1. Start a Summary from the analyses queue.
2. Choose the principal document and understand confirmed-relation recommendations.
3. Review the selected sources and start.
4. Understand the structured findings and their citations.
5. Approve the extraction from the review workspace.
6. Review and approve Word, review and approve PDF, then prepare the e-mail draft.
7. Locate the outputs under Biblioteca → Resultados and from analysis Details.

## C. Summary — rejected finding and extraction retry

1. Find a validation-rejected item and explain why it cannot enter the document.
2. Correct it with valid evidence or leave it excluded; unsupported override must be impossible.
3. Reject the complete extraction, provide guidance, and explain what is preserved and repeated.
4. Review the replacement extraction and locate the previous one under Versões e histórico.

## D. Revision — linear path

1. Start a Revision and select recommended supporting documents.
2. Confirm every source individually.
3. Review matrix lines, filter to pending legal decisions and decide each one.
4. Explain `Não aplicável` versus a pending legal decision.
5. Approve extraction, Word and PDF in order and prepare the e-mail.
6. Locate generated outputs and their producing analysis.

## E. Return and alternative path

1. From a generated document, choose to return to extraction review.
2. Before confirmation, explain what remains, what is superseded and what must be repeated.
3. Complete the alternate work and identify it by its reason rather than a path letter.
4. Compare the current and previous versions; activate an alternative only after a consequence explanation.

## F. Library detail and preview

1. Open one official document, one template and one generated Result.
2. Explain each visible tab and use its contextual Help icon.
3. Preview a DOCX as the original page rendition; if unavailable, identify the labelled text fallback reason.
4. Find technical metadata without it competing with the primary information.
5. Find existing reprocessing controls unchanged.

## G. Contextual Help

1. Follow Help from every analysis stage and every applicable Library-detail tab.
2. Arrive at the exact highlighted section.
3. Return to the same analysis/document state with browser Back or the return link.
4. Use Help to resolve a rejected finding, whole-extraction retry and version/history question without observer assistance.

## H. Tutorials and isolation

1. Start Biblioteca, Resumo and Revisão from the Tutoriais navigation entry.
2. Exit and resume each; restart and complete each at least twice.
3. Follow a contextual Help link and return without losing tutorial progress.
4. Before and after each run compare live business-table counts/hashes and OneDrive inventory: they must be identical.
5. Confirm no tutorial analysis or output appears in live Análises or Resultados.

## Evidence

Record task outcome, wrong turns, help sections used and unresolved language. Browser observation proves presentation and navigation; unit/API tests prove state gates and data isolation. Neither is reported as the other.
