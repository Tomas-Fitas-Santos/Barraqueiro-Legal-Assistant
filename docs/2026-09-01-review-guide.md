# What changed, and how to check it in production

Covers everything shipped under the plan agreed on 2026-08-31
(`~/.claude/plans/legal-assistant-clickup-and-folder-identity.md`), workstreams A, B, C, D, E,
G and F. Live at <https://barraqueiro-legal.naten.ai>.

Written to be worked through in order. Each section says what changed, why, and what to press.

---

## 0. Before you start

The client's data was wiped on 2026-08-31 for a clean regeneration, so the library is the
current OneDrive contents and there are no analyses yet. Two things follow:

- Anything about generated documents needs an analysis run first (§3 below).
- The three folders should hold only what belongs in them. `2. Templates` should show
  **exactly six files** — two `.docx`, two `.eml`, two `.json`.

Backups taken along the way, on the VM at `/root/backups/`:
`legal-2026-08-31-2212.sqlite`, `legal-pre-wipe-2026-08-31-2256.sqlite`,
`legal-pre-D3-2026-09-01-0120.sqlite`.

---

## 1. Naten's three issues

These came in on 2026-08-31 and are the reason the rest of the plan exists.

### 1.1 The logo, on every generated document and template

**Was:** generated documents carried no letterhead.

**Now:** the letterhead is part of the template itself, fitted to a fixed box
(25.4 × 24.02 mm) and never stretched or resampled — a Word file declares its print size
separately from the image's pixels, so the image the client gave us is embedded untouched and
only the declared extent is computed.

**Check:** open any template under `2. Templates` and any document generated from it. The logo
should sit in the header at the same size in both, and should not look squashed or soft.

**Where the image is changed:** Templates → a `.docx` template → **Editar** → the logo box.
Replacing it re-publishes every template that uses it.

### 1.2 Pressing "ver" on a template downloaded it instead of previewing

**Was:** templates, e-mails and other non-readable files had no preview, so the button fell
through to a download.

**Now:** every file in the library previews in place. A file the app cannot render directly is
converted to PDF on demand for the preview only.

**Check:** press **ver** on each of the six files in `2. Templates`. Each should open in the
preview drawer, not download. The `.docx` shows the Word rendering; the `.eml` shows the e-mail;
the `.json` shows the extraction laid out like the review screen, with a raw-JSON tab beside it.

**The rule behind it, worth knowing when testing:** a preview must never add anything to the
library or to what the app can cite. Previewing a file does not make its text quotable in an
analysis — text extracted for a preview is cached separately and never becomes a source.

### 1.3 An e-mail template, and a generated draft

**Was:** the subject and body of the delivery e-mail were written in the code that sends it,
so nobody outside the repository could change a word.

**Now:** the e-mail is a template like any other, one per workflow, editable at
Templates → the `.eml` → **Editar**. It carries `X-Unsent: 1`, so opening the file in a mail
client shows it as a draft rather than a sent message.

**Check:** edit the subject or body of `email-resumo.eml`, save, then generate a draft from an
analysis and confirm your wording came through. Attachments are now listed after the message
with name, type and size.

**What did NOT change, deliberately:** the §16 gate. An e-mail can only be prepared from a
final DOCX, a PDF converted from that exact version, and an explicit approval of that PDF. The
app still cannot send mail — there is no send capability anywhere in it. Only the wording moved
out of the code.

---

## 2. The library: three folders, three different things

`1. Documentos oficiais Barraqueiro`, `2. Templates` and `3. Documentos gerados` used to be
three names over identical behaviour — the same five tabs, the same processing, the same
options.

**Now** the kind is derived once from the path and read everywhere:

- **Official documents** are the client's source material. They get the full treatment: OCR,
  classification, the semantic profile, metadata, relations.
- **Templates** are stencils. They are not classified and are not candidates for a relation.
- **Generated documents** are the app's own output, with known provenance. They get Análises
  and never proposed relations.

**Check:**

1. Open a file from each folder. The tab strip should differ — a template has no Relações tab,
   a generated document has no proposed relations.
2. On an official document, **Relações → Adicionar manualmente**. The picker should offer only
   official documents. A relation to a template or to the app's own output is not a documental
   relation, and the list should not let you assert one.
3. The type shown for a file or folder should always be in Portuguese, never a raw English
   word. This applies to every label in the app, including relation status.

---

## 3. What the agent extracts is now yours to change

The deepest change in the batch, and the one worth the most testing time.

**Was:** the shape of an extraction — which fields the agent looks for — was fixed in the
code, in three places that had to agree with each other. Capturing one more thing about a
document meant a code change and a release.

**Now:** it is a template, `dados-resumo.json` and `dados-revisao.json`, edited at
Templates → the `.json` → **Editar**. Each field has a name, a label and a **description**, and
the description is not documentation — it is the instruction the agent receives. Adding a field
changes what the next run actually looks for.

**Check:**

1. Open `dados-resumo.json` → Editar. Add a field, e.g. key `clausula`, label `Cláusula`,
   description `O número da cláusula onde a obrigação consta.`
2. Run a **Resumo documental** analysis on a document that has numbered clauses.
3. The review screen should show a **Cláusula** row per extracted statement, with a citation
   behind it or marked as not confirmed.
4. Remove the field and confirm it disappears from new runs — and that an analysis run BEFORE
   the change still shows the fields it was made with. An approved extraction is a record of
   what was approved; it does not re-shape itself when the template changes.

**What you cannot edit, and why.** The citation spine — which document, which page, the
verbatim excerpt, the evidence quality, whether it was the agent's own suggestion — is fixed.
The §10/§11 checks rest on it, so a template that could delete "the excerpt" would be a template
that could switch off citation checking. Try it: the editor refuses those names, and refuses to
remove a field the code itself reads (`deadline` is the one to try — the rules use it to demand
a source for any deadline).

Every field you add inherits the same contract: the agent fills it from the document, or the
item is not confirmed.

**Fields are plain text.** No types are declared. The agent returns text for all of them,
`deadline` is deliberately "as written in the document" rather than a date, and nothing in the
app calculates on these values.

---

## 4. Relations: how sure, not just how relevant

**Was:** when the app proposed that two documents were related, it told you the **relevância** —
how much this document would change the analysis — and nothing about whether the link was real.

**Now** every relation carries a **confiança** beside it, derived from the evidence and never
self-reported by the model. The gap between the two axes is the interesting case: the closest
document in the library, on the same subject, with no reference to it in either text, is worth
reading *and* rests on nothing.

The bands:

| Confiança | What it means |
| --- | --- |
| Alta | The document is cited in the other's text, or a cited passage was found on the page named |
| Média | The document's title appears verbatim in the other's text |
| Baixa | Topic, entity or folder hints, with no reference in the text |
| Não confirmada | Similarity of subject alone |

Two cases worth pressing on:

- **Similarity alone is never "confirmed".** This is the §9 rule as a band: closeness may put a
  pair in front of you, it may never tell you the link is real.
- **A citation that did not check out is worse than no citation.** When the agent cites a
  passage and the app cannot find it on the page named, that lands at Baixa with a reason
  saying so — not silently ignored.

**Check:** on an official document's **Relações** tab, and on the confirmation gate when
starting an analysis, every relation should show a confiança pill and a sentence saying what it
rests on. A pill with no sentence behind it is a bug. A manually added relation reads
"Relação indicada por si" — a person deciding is the strongest evidence there is.

---

## 5. Relations stay correct as the library changes

Invisible from the UI, but it is what makes §4 trustworthy over time.

**Was:** one boolean per document, set on every document whenever any document was ingested.
Three consequences, all silent: a sweep that stopped early started again from the top; adding
one file re-compared all the others including pairs that had not moved; and **nothing withdrew
relations to a document that had been removed** — a deleted document kept appearing in other
documents' Relações tabs and in the confirmation gate, offered as a source for an analysis.

**Now:** the app records which *pairs* have been compared and at what content. "Needs work"
became a question with an answer instead of a flag someone has to remember to set.

**Check:**

1. Delete a document that other documents relate to. It should vanish from their Relações tabs
   and from the confirmation gate immediately.
2. The decision is withdrawn, not destroyed: if the document comes back, the relation and the
   decision you already made come back with it. You should not be asked about the same pair
   twice.
3. Correct a document's title or topics (Metadados). Its relations should be recomputed on the
   next pass — the content the comparison actually reads, not just the file, is what counts.

---

## 6. Things to watch for that are expected, not bugs

- **The Word templates are at version 4.** The rendering was made deterministic (it previously
  stamped the current time into the file, which would mint a new version on every restart). The
  content is provably unchanged, byte for byte.
- **Six files in `2. Templates`, not two.** The `.eml` and `.json` templates are new and are
  meant to be there.
- **The semantic index is not a user surface.** It is a processing artefact; there is nothing to
  open.
- **Embedding scores are only comparable to each other.** The app ranks by them and never
  compares them to a fixed number, which is why you will not see a similarity percentage
  anywhere.
- **Re-running OCR is never automatic.** It costs money per page, so stale OCR is always an
  explicit offer, per document. Stale *classification* does refresh by itself — it is free.

---

## 7. Known gaps

- The analyses have not yet been regenerated on the new logo-bearing templates. Existing
  outputs predate them.
- The letterhead backfill (which rewrote already-generated documents to add the logo) is a
  no-op now that the wipe cleared the generated documents. Open question whether to keep it.
- None of the above has been verified in a browser — there is no Chrome on the build machine.
  Everything here was verified through the API, the database and by rendering PDFs. The visual
  check is exactly what this document is for.
