// Turning a technical failure into something the chat can say.
//
// The internal messages are English, carry HTTP status codes and name folders and item ids.
// They are the right thing to keep in Histórico and in the logs, and the wrong thing to put
// in front of a lawyer — production showed "A conversão para PDF falhou: Could not create
// the folder "Resumo documental — PPRC (4ZAypg)" (HTTP 404).." inside a Portuguese chat.
//
// This maps the failures the app can actually produce onto a cause and, where there is one,
// something the reader can do. Anything unrecognised degrades to an honest sentence rather
// than to the raw text: the detail is one click away in Histórico either way.

// Cause and remedy come from ONE rule. Matching them separately let them disagree: the
// first version explained a missing library folder and then offered no way to fix it,
// because the two regexes were written apart and only one of them knew the wording Graph
// actually uses.
type Rule = { match: RegExp; cause: string; remedy?: string };

const ONEDRIVE = 'Verifique a ligação ao OneDrive nas Definições.';

const RULES: Rule[] = [
  {
    match: /library folder|pasta da biblioteca|create the folder|folder not found|itemNotFound/i,
    cause: 'não consegui aceder à pasta da biblioteca no OneDrive',
    remedy: ONEDRIVE,
  },
  {
    match: /download the file|read the item|read the library template/i,
    cause: 'não consegui abrir um ficheiro na biblioteca do OneDrive',
    remedy: ONEDRIVE,
  },
  { match: /not connected|não está ligado|sign in from settings/i, cause: 'a ligação ao OneDrive expirou', remedy: ONEDRIVE },
  {
    match: /not configured|não está configurad/i,
    cause: 'a ligação à IA não está configurada',
    remedy: 'Configure a ligação à IA nas Definições.',
  },
  { match: /upload failed|refused the change/i, cause: 'o OneDrive recusou a gravação do ficheiro' },
  { match: /PDF conversion failed|convert/i, cause: 'o OneDrive não conseguiu converter o documento em PDF' },
  { match: /timed out|timeout|ETIMEDOUT|ECONNRESET|fetch failed/i, cause: 'a ligação falhou a meio' },
  { match: /rate limit|429|quota/i, cause: 'o serviço de IA recusou por excesso de pedidos' },
];

function ruleFor(message: string): Rule | undefined {
  return RULES.find((candidate) => candidate.match.test(String(message || '')));
}

export function failureCause(message: string): string {
  return ruleFor(message)?.cause || 'ocorreu um erro técnico';
}

/** What to do about it, or '' when the only sensible answer is to try again. */
export function failureRemedy(message: string): string {
  return ruleFor(message)?.remedy || '';
}
