// What kinds of file this app can actually READ, declared once for the browser and the
// server.
//
// The library accepts anything — a client's OneDrive holds anything, and the delta sync
// inserts rows no upload dialog ever saw. But "accepted" and "readable" are different
// promises, and the app used to make only the first one while behaving as though it had
// made both: a JPG or an .msg landed in state `failed` with a message about PDF conversion,
// and every citation against it died with "página não existe".

export type SourceKind =
  | 'pdf'
  | 'image_jpeg'
  | 'image_png'
  | 'office'
  | 'email_eml'
  | 'email_msg'
  | 'text'
  | 'json'
  | 'unknown';

/** Extensions the file dialog suggests — a hint, never a rule the server relies on. */
export const READABLE_EXTENSIONS = [
  '.pdf',
  '.docx',
  '.doc',
  '.xlsx',
  '.pptx',
  '.jpg',
  '.jpeg',
  '.png',
  '.eml',
  '.msg',
  '.txt',
  '.md',
] as const;

export const UPLOAD_ACCEPT_ATTR = READABLE_EXTENSIONS.join(',');

/** How each kind is described to a person, in the language the app speaks. */
export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  pdf: 'PDF',
  image_jpeg: 'Imagem JPG',
  image_png: 'Imagem PNG',
  office: 'Documento Office',
  email_eml: 'E-mail (.eml)',
  email_msg: 'E-mail (.msg)',
  text: 'Texto',
  json: 'Dados (JSON)',
  unknown: 'Formato não reconhecido',
};

const READABLE_LIST = 'PDF (com texto ou digitalizado), Word, JPG, PNG e e-mail (.eml, .msg)';

/** Why a file has no text, in one sentence that also says what would have worked. */
export function unsupportedMessage(name: string): string {
  return `Não é possível ler “${name}”: este formato ainda não é lido pela aplicação. O ficheiro fica na biblioteca, mas sem texto nem citações. Formatos lidos: ${READABLE_LIST}.`;
}

export const OFFICE_NEEDS_GRAPH_MESSAGE =
  'Este documento não é PDF. Para extrair o texto é preciso ligar o Microsoft 365 nas Definições — a conversão para PDF acontece no OneDrive.';

export const OFFICE_NOT_ON_DRIVE_MESSAGE =
  'Este documento Word ainda não está no OneDrive do cliente, e é lá que a conversão para PDF acontece. Sincronize o OneDrive e volte a processá-lo.';

/**
 * A file the app cannot read, for a reason worth telling the user. Thrown by the rendition
 * builders, which are leaves — they must not reach for the API error type, or a plain
 * `node --test` could no longer load them.
 */
export class UnreadableFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableFileError';
  }
}

export function imageTooLargeMessage(megapixels: number): string {
  return `Imagem demasiado grande para ser lida (máximo ${megapixels} megapíxeis).`;
}

export const IMAGE_ENCODING_MESSAGE =
  'Esta imagem usa uma codificação que a aplicação não lê (PNG entrelaçado, HEIC ou TIFF). Guarde-a como JPG ou PNG normal.';
