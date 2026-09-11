import PizZip from 'pizzip';

import { renderDocx } from '@/lib/server/docx';

// Is this .docx usable as a template for the generated documents?
//
// A template the app cannot fill produces a document with holes in it, and the client would
// only find out at the end of an analysis. So a file dropped into the Templates folder is
// checked the moment it is discovered, and an unusable one is offered with the reason
// instead of being offered and then failing.
//
// Finding the placeholders is the delicate part. Word splits a placeholder across runs the
// moment anyone edits near it — `{doc_title}` becomes `{doc_` + `title}` in the XML — so
// matching the raw XML reports missing fields on precisely the templates someone has
// actually worked on. Stripping the tags first is what rejoins those runs: a placeholder
// never spans a paragraph, so the text that remains reads as the author wrote it.
//
// (docxtemplater ships an inspect module that would do this, but it requires lodash, which
// this app does not otherwise depend on.)

export type TemplateValidation = { valid: true } | { valid: false; error: string };

/** Sample data with the shape a real render supplies — enough to exercise every loop. */
const SMOKE_TEST_INPUT = {
  docTitle: 'Exemplo',
  subtitle: 'Verificação do template',
  mainDocument: 'Documento.pdf',
  date: '01-01-2026',
  sections: [{ heading: 'Secção', body: 'Texto de exemplo.' }],
  references: [{ n: 1, documentId: 'doc', document: 'Documento.pdf', version: '', page: 1, excerpt: 'exemplo' }],
  matrixLines: [
    {
      topic: 'Tema',
      current: 'Atual',
      related: 'Relacionado',
      difference: 'Diferença',
      proposed: 'Proposta',
      decision: 'Decisão',
    },
  ],
};

/** The parts of a .docx that can carry placeholders. */
const TEXT_PARTS = /^word\/(document|header\d*|footer\d*)\.xml$/;

/** Every placeholder name in the file, loops and conditionals included. */
export function templateTags(bytes: Buffer): Set<string> {
  const zip = new PizZip(bytes);
  const tags = new Set<string>();
  for (const name of Object.keys(zip.files)) {
    if (!TEXT_PARTS.test(name)) continue;
    const text = zip
      .file(name)!
      .asText()
      .replace(/<[^>]*>/g, '')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    for (const match of text.matchAll(/\{\s*[#/^]?\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}/g)) {
      tags.add(match[1]);
    }
  }
  return tags;
}

export function validateTemplateBytes(bytes: Buffer, requiredFields: string[]): TemplateValidation {
  let tags: Set<string>;
  try {
    const zip = new PizZip(bytes);
    if (!zip.file('word/document.xml')) throw new Error('not a docx');
    tags = templateTags(bytes);
  } catch {
    return { valid: false, error: 'O ficheiro não é um documento Word (.docx) válido.' };
  }

  const missing = requiredFields.filter((field) => !tags.has(field));
  if (missing.length) {
    return {
      valid: false,
      error: `Faltam os campos obrigatórios no template: ${missing.map((f) => `{${f}}`).join(', ')}.`,
    };
  }

  // The placeholders are there; only a real render proves they are arranged in a shape the
  // app can fill — an unclosed loop, or a loop used as a plain value.
  try {
    renderDocx({ templateBytes: bytes, ...SMOKE_TEST_INPUT });
  } catch (error) {
    const explanations = extractExplanations(error);
    return {
      valid: false,
      error: explanations.length
        ? `O template não pôde ser preenchido: ${explanations.join('; ')}.`
        : 'O template não pôde ser preenchido com dados de exemplo.',
    };
  }

  return { valid: true };
}

/** docxtemplater reports every problem at once, each with a human-readable explanation. */
function extractExplanations(error: unknown): string[] {
  const errors = (error as { properties?: { errors?: Array<{ properties?: { explanation?: string } }> } })?.properties
    ?.errors;
  if (!Array.isArray(errors)) {
    const message = error instanceof Error ? error.message : '';
    return message ? [message] : [];
  }
  return errors
    .map((e) => String(e?.properties?.explanation || ''))
    .filter(Boolean)
    .slice(0, 5);
}
