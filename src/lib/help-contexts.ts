export const HELP_CONTEXTS = {
  'analysis.sources': { section: 'preparar-fontes', label: 'Escolher e confirmar documentos' },
  'analysis.relations': { section: 'preparar-relacoes', label: 'Usar documentos relacionados' },
  'analysis.extraction.summary': { section: 'rever-resultados-resumo', label: 'Rever resultados do resumo' },
  'analysis.extraction.revision': { section: 'rever-resultados-revisao', label: 'Rever diferenças da revisão' },
  'analysis.extraction.rejected': { section: 'resultado-excluido', label: 'Compreender um resultado excluído' },
  'analysis.extraction.reject-all': { section: 'refazer-resultados', label: 'Rejeitar e refazer os resultados' },
  'analysis.return': { section: 'voltar-fase', label: 'Voltar a uma fase anterior' },
  'analysis.document': { section: 'aprovar-word', label: 'Rever e aprovar o documento Word' },
  'analysis.pdf': { section: 'aprovar-pdf', label: 'Rever e aprovar o PDF' },
  'analysis.email': { section: 'preparar-email', label: 'Preparar o rascunho de e-mail' },
  'analysis.details': { section: 'detalhes-analise', label: 'Compreender os detalhes da análise' },
  'analysis.history': { section: 'versoes-historico', label: 'Compreender versões e histórico' },
  'library.overview': { section: 'biblioteca', label: 'Compreender a Biblioteca' },
  'library.official.summary': { section: 'documento-resumo', label: 'Resumo do documento' },
  'library.official.metadata': { section: 'documento-metadados', label: 'Metadados do documento' },
  'library.official.relations': { section: 'preparar-relacoes', label: 'Relações do documento' },
  'library.official.analyses': { section: 'documento-analises', label: 'Análises ligadas ao documento' },
  'library.official.text': { section: 'documento-texto', label: 'Texto extraído do documento' },
  'library.template': { section: 'templates', label: 'Compreender e alterar Templates' },
  'library.result': { section: 'resultados', label: 'Compreender documentos produzidos' },
  tutorials: { section: 'tutoriais', label: 'Aprender com os tutoriais' },
} as const;

export type HelpContextId = keyof typeof HELP_CONTEXTS;

export type HelpSection = {
  id: string;
  label: string;
  group: 'Começar' | 'Preparar' | 'Analisar' | 'Aprovar' | 'Consultar' | 'Resolver';
};

export const HELP_SECTIONS: readonly HelpSection[] = [
  { id: 'comecar', label: 'Escolher o que fazer', group: 'Começar' },
  { id: 'tutoriais', label: 'Aprender sem alterar documentos', group: 'Começar' },
  { id: 'biblioteca', label: 'Preparar a Biblioteca', group: 'Preparar' },
  { id: 'documento-resumo', label: 'Resumo de um documento', group: 'Preparar' },
  { id: 'documento-metadados', label: 'Metadados', group: 'Preparar' },
  { id: 'documento-texto', label: 'Texto extraído', group: 'Preparar' },
  { id: 'preparar-relacoes', label: 'Confirmar relações primeiro', group: 'Preparar' },
  { id: 'documento-analises', label: 'Análises ligadas', group: 'Preparar' },
  { id: 'templates', label: 'Templates', group: 'Preparar' },
  { id: 'preparar-fontes', label: 'Escolher fontes', group: 'Analisar' },
  { id: 'rever-resultados-resumo', label: 'Resultados do resumo', group: 'Analisar' },
  { id: 'rever-resultados-revisao', label: 'Diferenças da revisão', group: 'Analisar' },
  { id: 'aprovar-word', label: 'Aprovar Word', group: 'Aprovar' },
  { id: 'aprovar-pdf', label: 'Aprovar PDF', group: 'Aprovar' },
  { id: 'preparar-email', label: 'Preparar e-mail', group: 'Aprovar' },
  { id: 'detalhes-analise', label: 'Detalhes da análise', group: 'Consultar' },
  { id: 'versoes-historico', label: 'Versões e histórico', group: 'Consultar' },
  { id: 'resultados', label: 'Resultados na Biblioteca', group: 'Consultar' },
  { id: 'resultado-excluido', label: 'Resultado excluído', group: 'Resolver' },
  { id: 'refazer-resultados', label: 'Rejeitar e refazer', group: 'Resolver' },
  { id: 'voltar-fase', label: 'Voltar a uma fase anterior', group: 'Resolver' },
  { id: 'problemas', label: 'Resolver problemas', group: 'Resolver' },
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
