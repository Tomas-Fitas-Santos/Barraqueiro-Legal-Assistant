import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ApiError } from '@/app/api/_helpers';
import { buildTemplateDocx, type Letterhead, type TemplateBlock, type TemplateDoc } from '@/lib/server/docx-blocks';
import { imageSize } from '@/lib/server/image-size';
import { getSetting, setSetting } from '@/lib/server/db';
import type { AnalysisType } from '@/lib/types';

/**
 * The built-in templates, as blocks rather than as .docx files in the repo.
 *
 * These are the TEAM's first versions; the client edits them from Settings. The rendered
 * .docx is a PRODUCT of the block list, so the registry's existing content-hash versioning
 * keeps working unchanged: an edit changes the blocks, the blocks change the bytes, and the
 * bytes changing is what mints a new version.
 */

const head: TemplateBlock[] = [
  { type: 'paragraph', text: 'GRUPO BARRAQUEIRO', style: 'Small' },
  { type: 'paragraph', text: '{doc_title}', style: 'Title' },
  { type: 'paragraph', text: '{subtitle}', style: 'Subtitle' },
  { type: 'paragraph', text: 'Documento principal: {main_document}    Data: {date}', style: 'Small' },
];

const sections: TemplateBlock = {
  type: 'loop',
  name: 'sections',
  blocks: [
    { type: 'paragraph', text: '{heading}', style: 'Heading1' },
    { type: 'paragraph', text: '{body}' },
  ],
};

const anexo: TemplateBlock[] = [
  { type: 'paragraph', text: 'Anexo de fontes', style: 'Heading1' },
  {
    type: 'table',
    rowLoop: 'references',
    columns: [
      { header: 'N.º', cell: '[{n}]', width: 600 },
      { header: 'Documento', cell: '{document}', width: 2300 },
      { header: 'Versão', cell: '{version}', width: 900 },
      { header: 'Página', cell: '{page}', width: 800 },
      { header: 'Excerto', cell: '{excerpt}', width: 4472 },
    ],
  },
  {
    type: 'paragraph',
    text: 'Gerado pela aplicação Assistente Jurídico. As afirmações citam documento, página e excerto; conteúdo sem suporte documental está assinalado.',
    style: 'Small',
  },
];

const matriz: TemplateBlock[] = [
  { type: 'paragraph', text: 'Matriz comparativa', style: 'Heading1' },
  {
    type: 'table',
    rowLoop: 'lines',
    columns: [
      { header: 'Tópico', cell: '{topic}', width: 1500 },
      { header: 'Conteúdo atual', cell: '{current}', width: 1750 },
      { header: 'Documento relacionado', cell: '{related}', width: 1750 },
      { header: 'Diferença', cell: '{difference}', width: 1750 },
      { header: 'Alteração proposta', cell: '{proposed}', width: 1622 },
      { header: 'Decisão', cell: '{decision}', width: 700 },
    ],
  },
];

export const BUILTIN_TEMPLATE_BLOCKS: Record<string, TemplateDoc> = {
  nota_resumo: { blocks: [...head, sections, ...anexo] },
  relatorio_revisao: { blocks: [...head, ...matriz, sections, ...anexo] },
};

export const BUILTIN_TEMPLATE_IDS = Object.keys(BUILTIN_TEMPLATE_BLOCKS);

export function analysisTypeOfBuiltin(templateId: string): AnalysisType {
  return templateId === 'relatorio_revisao' ? 'revision' : 'summary';
}

// ---------------------------------------------------------------------------
// The e-mail that delivers the document
// ---------------------------------------------------------------------------

/**
 * An e-mail template is a subject and a body, both with the same `{placeholders}` the Word
 * templates use. It is kept beside them in the library as a real `.eml`, so the client can
 * open it in a mail client and read it as the message it will become.
 *
 * The draft the app produces used to hard-code both lines, which meant the wording could
 * only be changed by a deploy — the half of Naten's third point that was a real gap.
 */
export type EmailTemplate = { subject: string; body: string };

export const BUILTIN_EMAIL_TEMPLATES: Record<string, EmailTemplate> = {
  email_resumo: {
    subject: '{analysis_type} — {main_document}',
    body: [
      'Exmos. Senhores,',
      '',
      'Junto se envia o documento em anexo ({version}).',
      '',
      'Com os melhores cumprimentos,',
      'Gabinete Legal & Compliance',
    ].join('\n'),
  },
  email_revisao: {
    subject: '{analysis_type} — {main_document}',
    body: [
      'Exmos. Senhores,',
      '',
      'Junto se envia o relatório de revisão do documento em epígrafe ({version}), com a matriz comparativa e as',
      'alterações propostas.',
      '',
      'Com os melhores cumprimentos,',
      'Gabinete Legal & Compliance',
    ].join('\n'),
  },
};

export const EMAIL_TEMPLATE_IDS = Object.keys(BUILTIN_EMAIL_TEMPLATES);

/** The fields the app fills in an e-mail template. */
export const EMAIL_TEMPLATE_FIELDS = ['analysis_type', 'main_document', 'version'];

export function analysisTypeOfEmailTemplate(templateId: string): AnalysisType {
  return templateId === 'email_revisao' ? 'revision' : 'summary';
}

function emailSetting(templateId: string): string {
  return `templates.email.${templateId}`;
}

export function emailTemplate(templateId: string): EmailTemplate | null {
  const edited = getSetting(emailSetting(templateId));
  if (edited) return JSON.parse(edited) as EmailTemplate;
  return BUILTIN_EMAIL_TEMPLATES[templateId] || null;
}

export function isEmailEdited(templateId: string): boolean {
  return Boolean(getSetting(emailSetting(templateId)));
}

export function saveEmailTemplate(templateId: string, tpl: EmailTemplate): void {
  if (!BUILTIN_EMAIL_TEMPLATES[templateId]) throw new ApiError('Template desconhecido.', 404);
  setSetting(emailSetting(templateId), JSON.stringify(tpl));
}

export function revertEmailTemplate(templateId: string): void {
  setSetting(emailSetting(templateId), '');
}

/** Substitute `{field}` from the values given; an unknown field is left visible, not blanked. */
export function fillEmailTemplate(tpl: EmailTemplate, values: Record<string, string>): EmailTemplate {
  const fill = (text: string) =>
    text.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (whole, field: string) =>
      Object.prototype.hasOwnProperty.call(values, field) ? values[field] : whole,
    );
  return { subject: fill(tpl.subject), body: fill(tpl.body) };
}

/**
 * The `.eml` a template renders to: the message with its placeholders still in it.
 *
 * `X-Unsent` makes a mail client open it as a draft rather than as received mail, which is
 * what a stencil should look like when the client double-clicks it.
 */
export function buildEmailTemplateEml(templateId: string): Buffer {
  const tpl = emailTemplate(templateId);
  if (!tpl) throw new ApiError('Template desconhecido.', 404);
  return buildEmailTemplateEmlFrom(tpl);
}

/** The same bytes, from a subject and body that have not been saved. */
export function buildEmailTemplateEmlFrom(tpl: EmailTemplate): Buffer {
  const eml = [
    'To: ',
    'Cc: ',
    `Subject: =?UTF-8?B?${Buffer.from(tpl.subject, 'utf8').toString('base64')}?=`,
    'X-Unsent: 1',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    tpl.body.replace(/\n/g, '\r\n'),
    '',
  ].join('\r\n');
  return Buffer.from(eml, 'utf8');
}

export function emailTemplateSha(templateId: string): string {
  return createHash('sha256').update(buildEmailTemplateEml(templateId)).digest('hex');
}

// ---------------------------------------------------------------------------
// The letterhead
// ---------------------------------------------------------------------------

/** The client's own mark, cropped from CÓDIGO DE CONDUTA. Replaceable from Settings. */
const DEFAULT_LOGO_FILE = path.join(process.cwd(), 'assets', 'barraqueiro-header-logo.jpg');
const DEFAULT_LOGO_PX = { w: 605, h: 572 };

const LOGO_SETTING = 'templates.logo';

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

type StoredLogo = { base64: string; extension: 'jpeg' | 'png'; px: { w: number; h: number } };

export function currentLetterhead(): Letterhead {
  const raw = getSetting(LOGO_SETTING);
  if (raw) {
    const stored = JSON.parse(raw) as StoredLogo;
    return { bytes: Buffer.from(stored.base64, 'base64'), extension: stored.extension, px: stored.px };
  }
  return { bytes: readFileSync(DEFAULT_LOGO_FILE), extension: 'jpeg', px: DEFAULT_LOGO_PX };
}

export function usingDefaultLetterhead(): boolean {
  return !getSetting(LOGO_SETTING);
}

/**
 * Replace the mark in the page header.
 *
 * The image is NOT resampled. A .docx declares the size it prints an image at separately
 * from the pixels it carries, so fitting a new mark into the existing box is a matter of
 * declaring the right extent — and doing it that way keeps every pixel the client gave us
 * instead of throwing resolution away to make a number match.
 */
export function setLetterhead(bytes: Buffer): { px: { w: number; h: number }; extension: 'jpeg' | 'png' } {
  if (bytes.length > MAX_LOGO_BYTES) {
    throw new ApiError('A imagem é demasiado grande (máximo 2 MB).', 400);
  }
  const size = imageSize(bytes);
  if (!size) throw new ApiError('Formato não suportado — envie uma imagem JPEG ou PNG.', 400);
  const stored: StoredLogo = {
    base64: bytes.toString('base64'),
    extension: size.extension,
    px: { w: size.width, h: size.height },
  };
  setSetting(LOGO_SETTING, JSON.stringify(stored));
  return { px: stored.px, extension: stored.extension };
}

export function resetLetterhead(): void {
  setSetting(LOGO_SETTING, '');
}

// ---------------------------------------------------------------------------
// Edited blocks
// ---------------------------------------------------------------------------

function blocksSetting(templateId: string): string {
  return `templates.blocks.${templateId}`;
}

/** The block list in force for a template: the client's edit when there is one, else ours. */
export function templateBlocks(templateId: string): TemplateDoc | null {
  const edited = getSetting(blocksSetting(templateId));
  if (edited) return JSON.parse(edited) as TemplateDoc;
  return BUILTIN_TEMPLATE_BLOCKS[templateId] || null;
}

export function isEdited(templateId: string): boolean {
  return Boolean(getSetting(blocksSetting(templateId)));
}

export function saveTemplateBlocks(templateId: string, doc: TemplateDoc): void {
  if (!BUILTIN_TEMPLATE_BLOCKS[templateId]) throw new ApiError('Template desconhecido.', 404);
  setSetting(blocksSetting(templateId), JSON.stringify(doc));
}

export function revertTemplateBlocks(templateId: string): void {
  setSetting(blocksSetting(templateId), '');
}

/**
 * A block list rendered with the letterhead in force, without saving it.
 *
 * This is what the editor previews. It is deliberately the SAME call the publish path makes,
 * so a preview cannot show one document and `Guardar e publicar` write another: the only
 * difference between them is whether the blocks came from the store or from the editor.
 */
export function renderTemplateDraft(doc: TemplateDoc): Buffer {
  return buildTemplateDocx(doc, currentLetterhead());
}

/** The .docx currently in force for a built-in template, blocks and letterhead together. */
export function renderBuiltinTemplate(templateId: string): Buffer {
  const doc = templateBlocks(templateId);
  if (!doc) throw new ApiError('Template desconhecido.', 404);
  return renderTemplateDraft(doc);
}

export function builtinTemplateSha(templateId: string): string {
  return createHash('sha256').update(renderBuiltinTemplate(templateId)).digest('hex');
}

export type { TemplateBlock, TemplateDoc };
