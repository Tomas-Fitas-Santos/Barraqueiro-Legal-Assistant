export const HELP_CONTEXTS = {
  // Biblioteca
  'library.overview': { section: 'biblioteca', label: 'Como usar a Biblioteca' },
  'library.official.summary': { section: 'documento-resumo', label: 'Como consultar o resumo do documento' },
  'library.official.metadata': { section: 'documento-metadados', label: 'Como rever e corrigir os metadados' },
  'library.official.relations': { section: 'preparar-relacoes', label: 'Como rever e decidir relações entre documentos' },
  'library.official.analyses': { section: 'documento-analises', label: 'Como consultar as análises ligadas ao documento' },
  'library.official.text': { section: 'documento-texto', label: 'Como verificar o texto extraído' },
  'library.template': { section: 'templates', label: 'Como consultar e editar Templates' },
  'library.result': { section: 'resultados', label: 'Como consultar um Resultado' },

  // Resumo documental — cada botão abre a instrução exata dentro deste capítulo.
  'analysis.summary.create': { section: 'criar-resumo', label: 'Como criar um Resumo documental' },
  'analysis.summary.sources': { section: 'preparar-fontes', label: 'Como escolher e confirmar os documentos' },
  'analysis.summary.extraction': { section: 'rever-resultados-resumo', label: 'Como rever os resultados do resumo' },
  'analysis.summary.rejected': { section: 'resultado-excluido', label: 'O que fazer com um resultado excluído' },
  'analysis.summary.reject-all': { section: 'refazer-resultados', label: 'Como rejeitar e refazer os resultados' },
  'analysis.summary.document': { section: 'aprovar-word', label: 'Como rever e aprovar o Word' },
  'analysis.summary.pdf': { section: 'aprovar-pdf', label: 'Como rever e aprovar o PDF' },
  'analysis.summary.email': { section: 'preparar-email', label: 'Como preparar o e-mail' },
  'analysis.summary.details': { section: 'detalhes-analise', label: 'Como consultar os detalhes da análise' },
  'analysis.summary.history': { section: 'versoes-historico', label: 'Como consultar versões e histórico' },

  // Revisão / Atualização — percurso completo e independente do capítulo de Resumo.
  'analysis.revision.create': { section: 'criar-revisao', label: 'Como criar uma Revisão / Atualização' },
  'analysis.revision.sources': { section: 'confirmar-fontes-revisao', label: 'Como escolher e confirmar os documentos' },
  'analysis.revision.extraction': { section: 'rever-resultados-revisao', label: 'Como rever e decidir as alterações' },
  'analysis.revision.rejected': { section: 'resultado-excluido-revisao', label: 'O que fazer com um resultado excluído' },
  'analysis.revision.reject-all': { section: 'refazer-resultados-revisao', label: 'Como rejeitar e refazer os resultados' },
  'analysis.revision.return': { section: 'voltar-fase', label: 'Como voltar a uma fase anterior' },
  'analysis.revision.document': { section: 'aprovar-word-revisao', label: 'Como rever e aprovar o Word' },
  'analysis.revision.pdf': { section: 'aprovar-pdf-revisao', label: 'Como rever e aprovar o PDF' },
  'analysis.revision.email': { section: 'preparar-email-revisao', label: 'Como preparar o e-mail' },
  'analysis.revision.details': { section: 'detalhes-analise-revisao', label: 'Como consultar os detalhes da análise' },
  'analysis.revision.history': { section: 'versoes-historico-revisao', label: 'Como consultar versões e histórico' },

  // Compatibilidade com o motor de workflow existente. Os botões resolvem estes contextos
  // genéricos para o capítulo certo através de resolveAnalysisHelpContext().
  'analysis.sources': { section: 'preparar-fontes', label: 'Como escolher e confirmar os documentos' },
  'analysis.relations': { section: 'confirmar-fontes-revisao', label: 'Como confirmar os documentos de apoio' },
  'analysis.extraction.summary': { section: 'rever-resultados-resumo', label: 'Como rever os resultados do resumo' },
  'analysis.extraction.revision': { section: 'rever-resultados-revisao', label: 'Como rever e decidir as alterações' },
  'analysis.extraction.rejected': { section: 'resultado-excluido', label: 'O que fazer com um resultado excluído' },
  'analysis.extraction.reject-all': { section: 'refazer-resultados', label: 'Como rejeitar e refazer os resultados' },
  'analysis.return': { section: 'voltar-fase', label: 'Como voltar a uma fase anterior' },
  'analysis.document': { section: 'aprovar-word', label: 'Como rever e aprovar o Word' },
  'analysis.pdf': { section: 'aprovar-pdf', label: 'Como rever e aprovar o PDF' },
  'analysis.email': { section: 'preparar-email', label: 'Como preparar o e-mail' },
  'analysis.details': { section: 'detalhes-analise', label: 'Como consultar os detalhes da análise' },
  'analysis.history': { section: 'versoes-historico', label: 'Como consultar versões e histórico' },

  tutorials: { section: 'biblioteca', label: 'Consultar as instruções da aplicação' },
} as const;

export type HelpContextId = keyof typeof HELP_CONTEXTS;
export type HelpAnalysisType = 'summary' | 'revision';

const GENERIC_ANALYSIS_CONTEXTS: Partial<Record<HelpContextId, Record<HelpAnalysisType, HelpContextId>>> = {
  'analysis.sources': {
    summary: 'analysis.summary.sources',
    revision: 'analysis.revision.sources',
  },
  'analysis.relations': {
    summary: 'analysis.summary.sources',
    revision: 'analysis.revision.sources',
  },
  'analysis.extraction.rejected': {
    summary: 'analysis.summary.rejected',
    revision: 'analysis.revision.rejected',
  },
  'analysis.extraction.reject-all': {
    summary: 'analysis.summary.reject-all',
    revision: 'analysis.revision.reject-all',
  },
  'analysis.return': {
    summary: 'analysis.summary.history',
    revision: 'analysis.revision.return',
  },
  'analysis.document': {
    summary: 'analysis.summary.document',
    revision: 'analysis.revision.document',
  },
  'analysis.pdf': {
    summary: 'analysis.summary.pdf',
    revision: 'analysis.revision.pdf',
  },
  'analysis.email': {
    summary: 'analysis.summary.email',
    revision: 'analysis.revision.email',
  },
  'analysis.details': {
    summary: 'analysis.summary.details',
    revision: 'analysis.revision.details',
  },
  'analysis.history': {
    summary: 'analysis.summary.history',
    revision: 'analysis.revision.history',
  },
};

export function resolveAnalysisHelpContext(context: HelpContextId, type: HelpAnalysisType): HelpContextId {
  if (context === 'analysis.extraction.summary') return 'analysis.summary.extraction';
  if (context === 'analysis.extraction.revision') return 'analysis.revision.extraction';
  return GENERIC_ANALYSIS_CONTEXTS[context]?.[type] || context;
}

export const HELP_CHAPTERS = ['Biblioteca', 'Resumo documental', 'Revisão / Atualização'] as const;
export type HelpChapter = (typeof HELP_CHAPTERS)[number];

export type HelpSection = {
  id: string;
  label: string;
  group: HelpChapter;
};

/**
 * O guia é deliberadamente organizado como três percursos completos. A ordem aqui é a
 * ordem de leitura na página Ajuda e no índice lateral.
 *
 * Algumas operações (Word, PDF, e-mail, detalhes e histórico) são iguais nos dois tipos de
 * análise. Mantemos uma secção em cada capítulo para que cada percurso possa ser lido do
 * início ao fim sem obrigar o utilizador a saltar para outro capítulo.
 */
export const HELP_SECTIONS: readonly HelpSection[] = [
  // Capítulo 1 — Biblioteca
  { id: 'biblioteca', label: 'Orientação e navegação', group: 'Biblioteca' },
  { id: 'documento-resumo', label: 'Abrir e compreender um documento', group: 'Biblioteca' },
  { id: 'documento-metadados', label: 'Rever e corrigir metadados', group: 'Biblioteca' },
  { id: 'preparar-relacoes', label: 'Rever relações entre documentos', group: 'Biblioteca' },
  { id: 'documento-analises', label: 'Consultar análises ligadas', group: 'Biblioteca' },
  { id: 'documento-texto', label: 'Verificar o texto extraído', group: 'Biblioteca' },
  { id: 'templates', label: 'Consultar e editar Templates', group: 'Biblioteca' },
  { id: 'resultados', label: 'Consultar Resultados produzidos', group: 'Biblioteca' },

  // Capítulo 2 — Resumo documental
  { id: 'criar-resumo', label: 'Criar um Resumo documental', group: 'Resumo documental' },
  { id: 'preparar-fontes', label: 'Escolher e confirmar documentos', group: 'Resumo documental' },
  { id: 'rever-resultados-resumo', label: 'Rever os resultados encontrados', group: 'Resumo documental' },
  { id: 'resultado-excluido', label: 'Tratar resultados excluídos', group: 'Resumo documental' },
  { id: 'refazer-resultados', label: 'Rejeitar e refazer os resultados', group: 'Resumo documental' },
  { id: 'detalhes-analise', label: 'Consultar os detalhes da análise', group: 'Resumo documental' },
  { id: 'versoes-historico', label: 'Consultar versões e histórico', group: 'Resumo documental' },
  { id: 'aprovar-word', label: 'Rever e aprovar o Word', group: 'Resumo documental' },
  { id: 'aprovar-pdf', label: 'Rever e aprovar o PDF', group: 'Resumo documental' },
  { id: 'preparar-email', label: 'Preparar o e-mail', group: 'Resumo documental' },

  // Capítulo 3 — Revisão / Atualização
  { id: 'criar-revisao', label: 'Criar uma Revisão / Atualização', group: 'Revisão / Atualização' },
  { id: 'confirmar-fontes-revisao', label: 'Escolher e confirmar documentos', group: 'Revisão / Atualização' },
  { id: 'rever-resultados-revisao', label: 'Rever e decidir as alterações', group: 'Revisão / Atualização' },
  { id: 'resultado-excluido-revisao', label: 'Tratar resultados excluídos', group: 'Revisão / Atualização' },
  { id: 'refazer-resultados-revisao', label: 'Rejeitar e refazer os resultados', group: 'Revisão / Atualização' },
  { id: 'voltar-fase', label: 'Voltar a uma fase anterior', group: 'Revisão / Atualização' },
  { id: 'detalhes-analise-revisao', label: 'Consultar os detalhes da análise', group: 'Revisão / Atualização' },
  { id: 'versoes-historico-revisao', label: 'Consultar versões e histórico', group: 'Revisão / Atualização' },
  { id: 'aprovar-word-revisao', label: 'Rever e aprovar o Word', group: 'Revisão / Atualização' },
  { id: 'aprovar-pdf-revisao', label: 'Rever e aprovar o PDF', group: 'Revisão / Atualização' },
  { id: 'preparar-email-revisao', label: 'Preparar o e-mail', group: 'Revisão / Atualização' },
] as const;

export function helpContext(context: HelpContextId) {
  return HELP_CONTEXTS[context];
}

export function helpHref(context: HelpContextId, returnTo = ''): string {
  const target = helpContext(context);
  const params = new URLSearchParams({ context });
  if (returnTo.startsWith('/')) params.set('returnTo', returnTo);
  return `/ajuda?${params.toString()}#${target.section}`;
}
