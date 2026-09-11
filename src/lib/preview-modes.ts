// What "see this document" means depends on what the document IS.
//
// Every preview used to offer the same two buttons, PDF and Texto, because a PDF is what
// the app produces for anything it can read. For a scan that is exactly wrong — the image
// is the document, and wrapping it in a PDF adds a viewer between the user and the picture.
// For an e-mail and for an extraction it is worse: the PDF is a rendering of a rendering,
// and the thing the user actually wants to check (who it was sent to, which fields the
// agent filled) is buried in a page image.
//
// So the modes are derived from the kind, and each kind names its own two: one presentation
// meant to be read, and one showing the file as it really is. Client-safe by design — the
// preview is a client component and must not need a round trip to know what to offer.

export type PreviewKind = 'pdf' | 'image' | 'email' | 'extraction' | 'document';

export type PreviewMode =
  /** The paged PDF, for things that genuinely are documents. */
  | 'pdf'
  /** The image itself. */
  | 'imagem'
  /** An e-mail laid out as an e-mail: headers, body, attachments. */
  | 'mensagem'
  /** An extraction laid out the way the review screen lays it out. */
  | 'dados'
  /** Text the app extracted — where a cited excerpt is highlighted. */
  | 'texto'
  /** The file's own bytes as text: the raw MIME source, or the raw JSON. */
  | 'fonte';

const EXTENSION = /\.([a-z0-9]+)$/i;

export function previewKindOf(name: string, mime: string): PreviewKind {
  const ext = (EXTENSION.exec(name)?.[1] || '').toLowerCase();
  if (ext === 'json' || mime === 'application/json') return 'extraction';
  if (ext === 'eml' || ext === 'msg' || mime === 'message/rfc822') return 'email';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext) || mime.startsWith('image/')) return 'image';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  return 'document';
}

const MODES: Record<PreviewKind, PreviewMode[]> = {
  pdf: ['pdf', 'texto'],
  document: ['pdf', 'texto'],
  // The picture, and what OCR read off it. A PDF wrapper around a photograph is a step
  // away from the evidence, not towards it.
  image: ['imagem', 'texto'],
  // Never a PDF. An .eml is a message; the second view is its real source, which is what
  // someone checking headers or an encoding problem actually needs.
  email: ['mensagem', 'fonte'],
  // Never a PDF either. The whole point of the JSON is that it is the machine-readable
  // record, so the raw file is a first-class view rather than a fallback.
  extraction: ['dados', 'fonte'],
};

export function previewModesFor(kind: PreviewKind): PreviewMode[] {
  return MODES[kind];
}

export function previewModeLabel(mode: PreviewMode, kind: PreviewKind, hasExcerpt = false): string {
  switch (mode) {
    case 'pdf':
      return 'PDF';
    case 'imagem':
      return 'Imagem';
    case 'mensagem':
      return 'Mensagem';
    case 'dados':
      return 'Dados';
    case 'texto':
      return hasExcerpt ? 'Texto + citação' : 'Texto';
    case 'fonte':
      return kind === 'extraction' ? 'JSON' : 'Origem';
  }
}
