import { ANALYSIS_TYPES, type AnalysisType } from '@/lib/types';

// Where things live in the library, declared once.
//
// The library mirrors ONE OneDrive folder, and three kinds of file end up in it: the
// client's own material, the Word templates that shape our output, and the documents this
// app produced. Before this module the app told those apart by pattern-matching a folder
// name spelled out in three different files — and the three had already drifted (one of
// them matched a prefix of the other two).
//
// This module is a leaf: it imports only types, so the wizard, the Library view, the sync
// and the upload paths all decide "what is this file" the same way.

export const LIBRARY_FOLDERS = {
  /** The client's source material. Everything not obviously ours belongs here. */
  official: '1. Documentos oficiais Barraqueiro',
  /** Word templates that format the generated documents, one subfolder per workflow. */
  templates: '2. Templates',
  /** What this app produced: one folder per analysis, holding its DOCX, PDF and JSON. */
  generated: '3. Resultados',
} as const;

/**
 * The per-workflow subfolder name. Deliberately NOT `ANALYSIS_TYPE_LABELS` — the revision
 * label is "Revisão / Atualização", and that slash is both illegal in a OneDrive item name
 * and the separator this app uses inside `documents.path`. Spelled out here it stays a
 * folder instead of silently becoming two.
 */
export const ANALYSIS_FOLDER_NAMES: Record<AnalysisType, string> = {
  summary: 'Resumo documental',
  revision: 'Revisão e Atualização',
};

/**
 * What the generated folder used to be called. Installs that ran before the reorganisation
 * have rows carrying this prefix, and those documents are still outputs of this app — so
 * the recognition below accepts both names, forever.
 */
export const PREVIOUS_GENERATED_FOLDER = '3. Documentos gerados';
export const LEGACY_GENERATED_FOLDER = 'Documentos gerados (Assistente Jurídico)';
export const GENERATED_FOLDER_ALIASES = [
  LIBRARY_FOLDERS.generated,
  PREVIOUS_GENERATED_FOLDER,
  LEGACY_GENERATED_FOLDER,
] as const;

/** Every folder the app creates and expects to exist, parents before children. */
export const STRUCTURAL_FOLDERS: string[] = [
  LIBRARY_FOLDERS.official,
  LIBRARY_FOLDERS.templates,
  ...ANALYSIS_TYPES.map((type) => `${LIBRARY_FOLDERS.templates}/${ANALYSIS_FOLDER_NAMES[type]}`),
  LIBRARY_FOLDERS.generated,
  ...ANALYSIS_TYPES.map((type) => `${LIBRARY_FOLDERS.generated}/${ANALYSIS_FOLDER_NAMES[type]}`),
];

/**
 * Is `path` the folder itself, or inside it? Segment-aware on purpose: a bare `startsWith`
 * also matches a sibling whose name merely begins the same way ("3. Resultados antigos"), which would quietly disqualify a client folder from being usable as a source.
 */
export function underFolder(path: string, folder: string): boolean {
  const p = String(path || '');
  return p === folder || p.startsWith(`${folder}/`);
}

/** A document this app produced. Never offered as source material for another analysis. */
export function isGeneratedOutput(path: string): boolean {
  return GENERATED_FOLDER_ALIASES.some((folder) => underFolder(path, folder));
}

/** A Word template. A stencil, not a document: never ingested, never citable. */
export function isTemplateFolder(path: string): boolean {
  return underFolder(path, LIBRARY_FOLDERS.templates);
}

/** Client source material — everything the app did not put there itself. */
export function isOfficialDocument(path: string): boolean {
  return !isGeneratedOutput(path) && !isTemplateFolder(path);
}

/**
 * What KIND of thing a file in the library is, decided once from its path.
 *
 * The three folders do not hold three arrangements of the same thing; they hold three
 * different things, and almost every question the app asks about a file has a different
 * answer for each. Source material is read, classified and related to other documents. A
 * template is a stencil: it has no subject, no metadata worth extracting and nothing to be
 * related to. A generated document is our own output, whose provenance is known exactly
 * rather than inferred.
 *
 * Everything downstream branches on THIS, instead of each caller re-deriving the same
 * three-way split from two booleans and getting a slightly different answer.
 */
export type DocumentKind = 'official' | 'template' | 'generated';

export function documentKind(path: string): DocumentKind {
  if (isGeneratedOutput(path)) return 'generated';
  if (isTemplateFolder(path)) return 'template';
  return 'official';
}

/** Never the raw enum in front of the user. */
export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  official: 'Documento oficial',
  template: 'Template',
  generated: 'Documento gerado',
};

/**
 * What the Tipo column shows for a file the APP owns rather than the client.
 *
 * Only an official document is classified by the model, so `doc_type` is empty for templates
 * and generated outputs and the column showed them all as "—". Their type is not a judgement
 * to be made, it is simply what the file IS, and the extension already says it: a template
 * folder holds one model of each of the three kinds, and a generated folder holds the
 * document, its PDF and the record of what was extracted. Naming them apart is the whole
 * value — three rows all reading "Template" would say less than the folder already does.
 */
export const TEMPLATE_FILE_PURPOSES = {
  docx: {
    label: 'Template de documento',
    purpose: 'Define a estrutura, o texto fixo e a apresentação do documento Word produzido.',
    authoring: 'Pode fazer ajustes simples no editor da aplicação ou criar um DOCX inteiramente novo fora da aplicação e carregá-lo na pasta do fluxo.',
  },
  eml: {
    label: 'Template de e-mail',
    purpose: 'Define o assunto e a mensagem do rascunho de e-mail que acompanha o PDF.',
    authoring: 'Pode ajustar o assunto e a mensagem diretamente no editor da aplicação.',
  },
  json: {
    label: 'Template de campos',
    purpose: 'Define os campos estruturados que a aplicação pede e apresenta na revisão dos resultados.',
    authoring: 'Pode ajustar os campos permitidos diretamente no editor da aplicação.',
  },
} as const;

export type TemplateFileKind = keyof typeof TEMPLATE_FILE_PURPOSES;

/** File type is the template's role; its workflow comes separately from its folder. */
export function templateFileKind(name: string): TemplateFileKind | null {
  const ext = String(name || '').trim().toLowerCase().split('.').pop() || '';
  return Object.prototype.hasOwnProperty.call(TEMPLATE_FILE_PURPOSES, ext) ? ext as TemplateFileKind : null;
}

export function ownedFileTypeLabel(kind: DocumentKind, name: string): string {
  if (kind === 'official') return '';
  const ext = String(name || '').toLowerCase().split('.').pop() || '';
  const byExt: Record<string, string> = kind === 'template'
    ? Object.fromEntries(Object.entries(TEMPLATE_FILE_PURPOSES).map(([key, value]) => [key, value.label]))
    : { docx: 'Documento gerado', pdf: 'PDF final', json: 'Dados extraídos', eml: 'Rascunho de e-mail' };
  return byExt[ext] || DOCUMENT_KIND_LABELS[kind];
}

/** Read as a document: OCR, classification, metadata, semantic profile, relations. */
export function isReadableDocument(path: string): boolean {
  return documentKind(path) === 'official';
}

export function templateFolderPath(type: AnalysisType): string {
  return `${LIBRARY_FOLDERS.templates}/${ANALYSIS_FOLDER_NAMES[type]}`;
}

export function generatedFolderPath(type: AnalysisType): string {
  return `${LIBRARY_FOLDERS.generated}/${ANALYSIS_FOLDER_NAMES[type]}`;
}

/** Which workflow a file under `2. Templates/<type>/…` is a template for. */
export function analysisTypeForTemplatePath(path: string): AnalysisType | null {
  for (const type of ANALYSIS_TYPES) {
    if (underFolder(String(path || ''), templateFolderPath(type))) return type;
  }
  return null;
}

/** OneDrive rejects these outright; so must we, before spending a round trip to find out. */
export const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|]/;

/** Names Windows reserves. A file called CON breaks in ways nobody will connect to us. */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul', 'desktop.ini',
  ...Array.from({ length: 10 }, (_, i) => `com${i}`),
  ...Array.from({ length: 10 }, (_, i) => `lpt${i}`),
]);

export type NameCheck = { ok: true; name: string } | { ok: false; error: string };

/**
 * Is this a usable name for a file or folder on the client's OneDrive?
 *
 * The rules are not obvious and are not ours — they are the drive's — so they live in one
 * place that the rename, the new-folder dialog and the upload path all consult, rather than
 * being discovered one 400 at a time.
 */
export function validateItemName(name: string): NameCheck {
  const trimmed = String(name || '').trim();
  if (!trimmed) return { ok: false, error: 'O nome não pode ficar vazio.' };
  if (trimmed.length > 255) return { ok: false, error: 'O nome não pode ter mais de 255 caracteres.' };
  if (ILLEGAL_NAME_CHARS.test(trimmed)) {
    return { ok: false, error: 'O nome não pode conter \\ / : * ? " < > |' };
  }
  // Surrounding whitespace is trimmed rather than refused — OneDrive does the same, and the
  // caller uses the returned `name`, so " Contratos " simply becomes "Contratos".
  if (trimmed.endsWith('.')) return { ok: false, error: 'O nome não pode terminar com um ponto.' };
  if (trimmed === '.' || trimmed === '..') return { ok: false, error: 'Esse nome não é válido.' };
  if (trimmed.startsWith('~$')) return { ok: false, error: 'Esse nome está reservado pelo Office.' };
  const base = trimmed.toLowerCase().split('.')[0];
  if (RESERVED_NAMES.has(base) || RESERVED_NAMES.has(trimmed.toLowerCase())) {
    return { ok: false, error: `“${trimmed}” é um nome reservado pelo sistema.` };
  }
  return { ok: true, name: trimmed };
}

/**
 * A folder the app itself creates and depends on. Renaming, moving or deleting one leaves
 * the install with two of them, because `ensureLibraryStructure()` recreates what is missing.
 */
export function isStructuralFolder(path: string): boolean {
  return STRUCTURAL_FOLDERS.includes(String(path || ''));
}

// `displayPath()` and `uploadTargetPath()` lived here until phase 5.
//
// They existed because the three folders were introduced over a library the client had
// already filled, and nothing of theirs was moved: `displayPath` LISTED those files under
// "1. Documentos oficiais" without them being there. The legacy migration
// (`repo/library-migration.ts`) moves them for real, so the remapping had nothing left to
// do — and a path that is true everywhere is worth more than one the Library has to undo
// on every read. Every `documents.path` is now the path.
