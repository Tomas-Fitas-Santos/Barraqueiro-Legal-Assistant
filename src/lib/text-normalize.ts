// Folding Portuguese text so that comparisons ignore what a reader ignores.
//
// A leaf, and client-safe: the Library's name filter, the relation engine's reference
// matching and any future search all have to agree on what "the same word" means. This was
// already implemented once, inline in repo/relations.ts, while the Library's filter used a
// raw lowercase `includes` — which is why searching "concessao" never found "Concessão".

/**
 * Lowercase, strip diacritics, collapse whitespace. `Concessão` and `concessao` fold to the
 * same string; `ç` folds to `c`, matching what SQLite's FTS5 tokenizer already does to the
 * document text, so the two halves of a search agree.
 */
export function foldPt(text: string): string {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The folded words of a string, for token-coverage matching. */
export function foldTokens(text: string): string[] {
  return foldPt(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Does `haystack` contain `needle`, ignoring case, accents and whitespace differences? */
export function foldedIncludes(haystack: string, needle: string): boolean {
  const n = foldPt(needle);
  return n.length > 0 && foldPt(haystack).includes(n);
}
