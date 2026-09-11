import { UnreadableFileError } from '@/lib/ingest-types';
import { assertReadableCompoundFile } from '@/lib/server/ingest/compound-file';

// An e-mail as a readable, citable document — and the attachments it carries.
//
// A .msg or .eml is often just an envelope: the thing the lawyer actually needs is the PDF
// inside it. So an e-mail yields BOTH — the message itself becomes a document (headers and
// body, citable line by line) and each attachment becomes a document of its own, ingested
// normally. A contract attached to a covering note is analysable, which was the point.
//
// RFC822 is not one format but five overlapping ones (nested multipart, RFC2047 encoded
// words, RFC2231 parameter continuations, quoted-printable, legacy charsets), so parsing it
// by hand inside an app whose whole promise is verbatim citation is the wrong risk.

export type EmailAttachment = {
  filename: string;
  mimeType: string;
  bytes: Buffer;
  /** Signature logos and tracking pixels reference themselves from the HTML body. */
  inline: boolean;
  contentId: string;
};

export type ParsedEmail = {
  from: string;
  to: string;
  cc: string;
  date: string;
  subject: string;
  messageId: string;
  bodyText: string;
  attachments: EmailAttachment[];
};

export async function parseEmail(bytes: Buffer, kind: 'email_eml' | 'email_msg'): Promise<ParsedEmail> {
  return kind === 'email_msg' ? parseMsg(bytes) : parseEml(bytes);
}

async function parseEml(bytes: Buffer): Promise<ParsedEmail> {
  const { default: PostalMime } = await import('postal-mime');
  const mail = await new PostalMime().parse(new Uint8Array(bytes));
  const address = (a?: { name?: string; address?: string } | null) =>
    a ? [a.name, a.address ? `<${a.address}>` : ''].filter(Boolean).join(' ').trim() : '';
  const list = (items?: Array<{ name?: string; address?: string }> | null) =>
    (items || []).map(address).filter(Boolean).join('; ');

  const html = String(mail.html || '');
  const text = String(mail.text || '') || (html ? htmlToText(html) : '');
  return {
    from: address(mail.from),
    to: list(mail.to),
    cc: list(mail.cc),
    date: String(mail.date || ''),
    subject: String(mail.subject || ''),
    messageId: String(mail.messageId || ''),
    bodyText: text,
    attachments: (mail.attachments || []).map((att) => ({
      filename: String(att.filename || 'anexo'),
      mimeType: String(att.mimeType || 'application/octet-stream'),
      bytes: Buffer.from(att.content as ArrayBuffer),
      inline: att.disposition === 'inline',
      contentId: String(att.contentId || '').replace(/^<|>$/g, ''),
    })),
  };
}

async function parseMsg(bytes: Buffer): Promise<ParsedEmail> {
  // Before the parser sees it: a malformed compound file makes it allocate until the heap
  // dies, and a heap abort is not catchable. See compound-file.ts.
  assertReadableCompoundFile(bytes);
  // msgreader is CommonJS with an `exports.default`, so under Node's ESM interop the class
  // arrives one level deeper than the import statement suggests.
  type Ctor = typeof import('@kenjiuno/msgreader').default;
  const imported = (await import('@kenjiuno/msgreader')) as unknown as { default: { default?: Ctor } & Ctor };
  const MsgReader: Ctor = imported.default.default ?? imported.default;
  let data;
  try {
    const reader = new MsgReader(bytes);
    data = reader.getFileData();
    if (data.error) throw new Error(data.error);

    const recipients = (data.recipients || []).map((r) =>
      [r.name, r.email ? `<${r.email}>` : ''].filter(Boolean).join(' ').trim(),
    );
    const html = String(data.bodyHtml || '');
    const bodyText = String(data.body || '') || (html ? htmlToText(html) : '');

    const attachments: EmailAttachment[] = [];
    for (const att of data.attachments || []) {
      // An embedded message is a storage, not a byte stream — it needs its own reader pass,
      // which the caller does by recursing on the extracted bytes. msgreader cannot hand us
      // those bytes, so an embedded .msg is reported rather than silently dropped.
      if (att.innerMsgContent) continue;
      const content = reader.getAttachment(att);
      attachments.push({
        filename: String(att.fileName || content.fileName || 'anexo'),
        mimeType: String(att.attachMimeTag || 'application/octet-stream'),
        bytes: Buffer.from(content.content),
        inline: Boolean(att.pidContentId),
        contentId: String(att.pidContentId || ''),
      });
    }

    return {
      from: [data.senderName, data.senderEmail ? `<${data.senderEmail}>` : ''].filter(Boolean).join(' ').trim(),
      to: recipients.join('; '),
      cc: '',
      date: String(data.messageDeliveryTime || data.clientSubmitTime || ''),
      subject: String(data.subject || ''),
      messageId: String(data.messageId || ''),
      bodyText,
      attachments,
    };
  } catch (error) {
    throw new UnreadableFileError(
      `Não foi possível ler este e-mail (.msg): ${error instanceof Error ? error.message : 'formato não reconhecido'}.`,
    );
  }
}

/**
 * The citable header block, above the body. It is text like any other, so a statement can
 * cite "De:" or the subject line and the citation validator can verify it on page 1.
 */
export function renderEmailText(email: ParsedEmail): string {
  const header = [
    `De: ${email.from || '—'}`,
    `Para: ${email.to || '—'}`,
    `Cc: ${email.cc || '—'}`,
    `Data: ${formatDate(email.date)}`,
    `Assunto: ${email.subject || '—'}`,
    // Latin-1 only: a box-drawing rule would trip the "not representable" note on every
    // single e-mail the app reads.
    '-'.repeat(60),
    '',
  ].join('\n');
  return `${header}${email.bodyText || '(mensagem sem corpo de texto)'}${attachmentBlock(email)}`;
}

/**
 * What is attached, listed after the message rather than squeezed onto a header line.
 *
 * A one-line "Anexos: a.pdf; b.pdf" is unreadable exactly when it matters — several files,
 * or one whose name is long — and it hides the two things someone judging an e-mail needs:
 * how big each attachment is, and whether it is a real attachment or a signature logo the
 * body references. Inline parts are counted, not listed, because naming them is noise.
 */
function attachmentBlock(email: ParsedEmail): string {
  const real = email.attachments.filter((a) => !a.inline);
  const inline = email.attachments.length - real.length;
  if (!real.length && !inline) return '';
  const lines = ['', '', '-'.repeat(60), `Anexos (${real.length})`];
  for (const attachment of real) {
    lines.push(`  - ${attachment.filename || '(sem nome)'} — ${attachment.mimeType || 'tipo desconhecido'}, ${formatBytes(attachment.bytes.length)}`);
  }
  if (!real.length) lines.push('  (nenhum)');
  if (inline) lines.push(`  ${inline} imagem(ns) incorporada(s) na mensagem.`);
  return lines.join('\n');
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} kB`;
  return `${Math.round((size / (1024 * 1024)) * 10) / 10} MB`;
}

function formatDate(value: string): string {
  if (!value) return '—';
  const at = Date.parse(value);
  return Number.isNaN(at) ? value : new Date(at).toISOString().slice(0, 16).replace('T', ' ');
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  euro: '€',
};

/**
 * Enough HTML to read an e-mail whose sender wrote it in Outlook. Tables and images degrade
 * — but the PDF the user previews is built from THIS text, so what they see is exactly what
 * the analysis can cite. Lossy, never misleading.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|blockquote)>/gi, '\n\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[String(name).toLowerCase()] ?? match)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
