'use client';

import type { ReactNode } from 'react';
import { CircleHelp } from 'lucide-react';

import { HELP_SECTIONS } from '@/lib/help-contexts';

function Callout({ title, children, tone = 'accent' }: { title: string; children: ReactNode; tone?: 'accent' | 'warning' }) {
  return <div className={`rounded-lg border-l-4 px-5 py-4 ${tone === 'warning' ? 'border-warning bg-warning-soft' : 'border-accent bg-accent-soft'}`}><p className="m-0 font-medium text-ink0">{title}</p><div className="mt-1.5 text-ink1">{children}</div></div>;
}

function Steps({ rows }: { rows: Array<[string, ReactNode]> }) {
  return <ol className="m-0 flex list-none flex-col gap-3 p-0">{rows.map(([title, body], index) => <li key={`${index}-${title}`} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3"><span aria-hidden className="mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent-strong">{index + 1}</span><div><p className="m-0 font-medium text-ink0">{title}</p><div className="mt-0.5 text-ink1">{body}</div></div></li>)}</ol>;
}

function StatusRows({ rows }: { rows: Array<[string, string]> }) {
  return <div className="overflow-hidden rounded-lg border border-line0">{rows.map(([label, meaning], index) => <div key={label} className={`grid gap-1 px-4 py-3 md:grid-cols-[14rem_1fr] ${index ? 'border-t border-line0' : ''}`}><strong className="text-ink0">{label}</strong><span>{meaning}</span></div>)}</div>;
}

const resultExcluded = <><p className="m-0">Um resultado excluído não entra no documento final. Abra sempre o motivo antes de decidir o que fazer.</p><Steps rows={[
  ['Abra o resultado excluído', <>Leia o motivo apresentado e identifique qual fonte, página ou excerto falhou a validação.</>],
  ['Confirme a fonte', <>Abra a citação e compare-a com o documento original. Não aceite uma afirmação apenas porque o texto parece plausível.</>],
  ['Escolha a ação adequada', <>Corrija a origem e refaça a extração quando existe um problema corrigível; caso contrário, mantenha o resultado excluído.</>],
]} /><Callout title="O registo é preservado">Um resultado excluído continua visível para auditoria, mas não é incluído no Word.</Callout></>;

const redoResults = <><p className="m-0">Use esta ação quando o problema está no conjunto de resultados e não apenas num item isolado.</p><Steps rows={[
  ['Escolha rejeitar/refazer', <>Use a ação disponível na área de revisão dos resultados.</>],
  ['Explique o que está errado', <>Indique de forma concreta o que deve mudar na nova tentativa.</>],
  ['Confirme a nova tentativa', <>A aplicação preserva a extração anterior e inicia outra. Reveja os novos resultados antes de os aprovar.</>],
]} /><Callout title="Atenção" tone="warning">Rejeitar o conjunto não apaga a tentativa anterior e não permite gerar um documento a partir de resultados ainda não aprovados.</Callout></>;

const analysisDetails = <Steps rows={[
  ['Abra o separador Detalhes', <>Aqui encontra o tipo de análise, o documento principal, os documentos confirmados e as instruções usadas.</>],
  ['Confirme as fontes', <>Verifique quais os documentos que participaram efetivamente na análise antes de interpretar os resultados.</>],
  ['Consulte os ficheiros produzidos', <>O bloco de resultados distingue as versões Word, o PDF, o registo estruturado e o e-mail produzidos durante o percurso.</>],
]} />;

const analysisHistory = <><Steps rows={[
  ['Abra Versões e histórico', <>Consulte o percurso da análise e as tentativas criadas ao longo do trabalho.</>],
  ['Selecione a etapa que pretende inspecionar', <>Veja as decisões e os ficheiros dessa etapa sem alterar automaticamente o percurso ativo.</>],
  ['Mude de percurso apenas quando necessário', <>Use “Passar a trabalhar nesta tentativa” quando quer continuar a partir dessa alternativa.</>],
]} /><Callout title="O histórico não é apagado">Voltar a uma etapa cria uma nova tentativa. As decisões e versões anteriores continuam disponíveis para consulta.</Callout></>;

const approveWord = <><Steps rows={[
  ['Abra o Word gerado', <>Leia o documento completo e confirme que só contém resultados que decidiu manter.</>],
  ['Peça alterações antes de aprovar, se necessário', <>Se encontrar um problema, use as ações de alteração disponíveis e volte a rever a nova versão.</>],
  ['Aprove a versão correta', <>A aprovação escolhe esse Word como versão final e permite avançar para o PDF.</>],
]} /><Callout title="Uma versão nova não apaga as anteriores">As versões anteriores permanecem no histórico. Se o Word final mudar, um PDF criado a partir de outra versão fica desatualizado.</Callout></>;

const approvePdf = <Steps rows={[
  ['Abra a pré-visualização do PDF', <>Percorra o documento página a página.</>],
  ['Compare com o Word aprovado', <>Confirme conteúdo, paginação e apresentação antes de continuar.</>],
  ['Aprove o PDF', <>Depois da aprovação, a aplicação pode preparar o rascunho de e-mail correspondente.</>],
]} />;

const prepareEmail = <><Steps rows={[
  ['Abra o rascunho de e-mail', <>Confirme que o PDF aprovado é o ficheiro associado ao rascunho.</>],
  ['Reveja destinatários, assunto e mensagem', <>Corrija o que for necessário antes de aprovar.</>],
  ['Aprove e descarregue o .eml', <>Abra depois o ficheiro no programa de correio e faça o envio manualmente.</>],
]} /><Callout title="A aplicação não envia o e-mail">A aprovação prepara o rascunho. O envio continua a ser uma ação do utilizador no programa de correio.</Callout></>;

export const HELP_TOPIC_BODIES: Record<string, ReactNode> = {
  // ---------------------------------------------------------------------------
  // Capítulo 1 — Biblioteca
  // ---------------------------------------------------------------------------
  biblioteca: <><p className="m-0">Use a Biblioteca para preparar e consultar toda a informação que alimenta as análises. As três áreas têm funções diferentes: <strong>Documentos oficiais</strong> são as fontes, <strong>Templates</strong> definem o formato do que é produzido e <strong>Resultados</strong> guardam os ficheiros gerados.</p><Steps rows={[
    ['Entre na pasta de que precisa', <>Abra Documentos oficiais, Templates ou Resultados a partir da lista principal.</>],
    ['Encontre o ficheiro', <>Use o filtro por nome ou navegue pelas pastas. O filtro procura nomes; não pesquisa o texto dentro dos documentos.</>],
    ['Abra o detalhe', <>Selecione o documento para consultar o seu estado, informação extraída e ações disponíveis.</>],
    ['Sincronize quando existirem alterações externas', <>Use “Sincronizar” para refletir na aplicação alterações efetuadas no OneDrive.</>],
  ]} /><StatusRows rows={[
    ['Recebido / em leitura', 'O documento ainda está a ser preparado e não deve ser usado como fonte.'],
    ['Pronto', 'Pode ser escolhido numa análise e usado para citações.'],
    ['Pronto com alerta', 'Pode ser usado, mas deve verificar as páginas assinaladas.'],
    ['Erro', 'Abra o documento, consulte o problema e use Reprocessar quando apropriado.'],
  ]} /></>,

  'documento-resumo': <><Steps rows={[
    ['Abra o documento na Biblioteca', <>Na lista, selecione o ficheiro e entre no respetivo detalhe.</>],
    ['Comece pelo separador Resumo', <>Confirme o nome, o tipo de documento e o estado de processamento.</>],
    ['Use Pré-visualizar para ver o original', <>Quando precisar de validar conteúdo, consulte o ficheiro original em vez de depender apenas do texto extraído.</>],
    ['Resolva alertas antes de analisar', <>Se o documento não estiver pronto ou apresentar um erro, trate esse problema antes de o escolher como fonte.</>],
  ]} /><Callout title="Regra prática">Antes de iniciar uma análise, confirme que o documento principal está pronto e que consegue abrir a sua pré-visualização.</Callout></>,

  'documento-metadados': <><Steps rows={[
    ['Abra Metadados', <>Consulte o tipo, título, versão, datas, temas e referências identificados pela aplicação.</>],
    ['Compare com o documento original', <>Corrija apenas informação que consiga confirmar no documento.</>],
    ['Edite o campo incorreto e guarde', <>A correção humana passa a prevalecer sobre a classificação automática desse campo.</>],
  ]} /><Callout title="Guardar metadados não reprocessa o ficheiro">OCR, classificação e restantes operações de leitura só voltam a correr através das ações próprias de reprocessamento.</Callout></>,

  'preparar-relacoes': <><p className="m-0">As Relações indicam que dois documentos podem ter de ser considerados em conjunto. Decida as propostas antes de iniciar uma análise sempre que possível.</p><Steps rows={[
    ['Abra Relações no documento oficial', <>Veja os documentos relacionados que a aplicação propôs ou que foram adicionados manualmente.</>],
    ['Leia a prova apresentada', <>Consulte o tipo de relação, a confiança, a justificação e qualquer referência ou excerto disponível.</>],
    ['Confirme ou rejeite', <>Confirme apenas quando a ligação fizer sentido. Rejeite quando os documentos não devam ser tratados como relacionados.</>],
    ['Volte a verificar relações pendentes', <>Um número no separador Relações indica decisões que ainda precisam de atenção.</>],
  ]} /><Callout title="Confirmar uma relação não aprova conteúdo">A relação ajuda a recomendar fontes numa análise. Cada resultado continua a ter de apresentar uma citação válida.</Callout></>,

  'documento-analises': <Steps rows={[
    ['Abra Análises no detalhe do documento', <>A lista mostra os processos em que este documento foi utilizado.</>],
    ['Confirme o papel do documento', <>Veja se foi utilizado como documento principal ou como documento de apoio.</>],
    ['Abra a análise que pretende consultar', <>Use o estado para perceber se existe trabalho pendente e continue a partir da própria análise.</>],
  ]} />,

  'documento-texto': <><Steps rows={[
    ['Abra Texto', <>Consulte o conteúdo que a aplicação conseguiu extrair, organizado pelas páginas de origem.</>],
    ['Procure a página relevante', <>As citações da análise dependem desta correspondência entre texto e página.</>],
    ['Compare com Pré-visualizar quando houver dúvida', <>Se o texto estiver incompleto ou incorreto, valide no original e reprocese o documento quando necessário.</>],
  ]} /><Callout title="O texto extraído é uma ferramenta de verificação">A fonte final continua a ser o documento original e a respetiva página.</Callout></>,

  templates: <><p className="m-0">Os Templates controlam a estrutura dos documentos, do e-mail e dos campos procurados durante cada fluxo.</p><Steps rows={[
    ['Abra a pasta Templates', <>Escolha o fluxo e depois o Template que pretende consultar.</>],
    ['Confirme o tipo de Template', <>Word define o documento produzido; e-mail define o rascunho; campos define a informação estruturada procurada.</>],
    ['Abra a pré-visualização antes de editar', <>Confirme que está no Template correto e veja o conteúdo atual.</>],
    ['Edite e publique apenas quando a alteração estiver pronta', <>Uma versão publicada passa a ser usada pelas análises futuras desse fluxo.</>],
  ]} /><Callout title="Alterações não são retroativas">Análises anteriores continuam associadas à versão de Template com que foram produzidas.</Callout></>,

  resultados: <><Steps rows={[
    ['Abra a pasta Resultados', <>Localize os ficheiros produzidos pela análise que pretende consultar.</>],
    ['Abra o detalhe do ficheiro', <>Confirme o tipo de resultado, o estado e a análise que lhe deu origem.</>],
    ['Siga a ligação para a análise quando precisar de contexto', <>A análise conserva as fontes, decisões, versões e aprovações que explicam como esse ficheiro foi produzido.</>],
  ]} /><Callout title="Cada ficheiro tem o seu próprio estado">Por exemplo, aprovar o PDF não atribui automaticamente o mesmo estado ao Word, JSON ou e-mail.</Callout></>,

  // ---------------------------------------------------------------------------
  // Capítulo 2 — Resumo documental
  // ---------------------------------------------------------------------------
  'criar-resumo': <><Steps rows={[
    ['Abra Processos e escolha Nova análise', <>Inicie um novo processo a partir da lista de análises.</>],
    ['Escolha Resumo documental', <>Este fluxo serve para identificar e organizar informação relevante de um documento.</>],
    ['Selecione o documento principal', <>Escolha um Documento oficial que esteja pronto.</>],
    ['Confirme os documentos de apoio apresentados', <>Inclua apenas fontes que devam poder sustentar conclusões nesta análise.</>],
    ['Reveja a configuração e inicie a análise', <>Confirme as escolhas antes de pedir à aplicação para ler os documentos.</>],
  ]} /></>,

  'preparar-fontes': <><Steps rows={[
    ['Confirme o documento principal', <>Verifique o nome e abra-o se precisar de validar o conteúdo antes de avançar.</>],
    ['Reveja cada documento de apoio', <>Leia a razão pela qual foi sugerido e confirme apenas as fontes relevantes para este resumo.</>],
    ['Exclua sugestões que não devem ser usadas', <>Excluir aqui retira a fonte desta análise; não elimina o documento da Biblioteca.</>],
    ['Inicie a leitura quando as fontes estiverem corretas', <>A aplicação só pode citar documentos que tenham sido confirmados para a análise.</>],
  ]} /><Callout title="Confirmar uma fonte é autorizar a sua utilização">Se não quer que um documento sustente conclusões deste resumo, não o confirme.</Callout></>,

  'rever-resultados-resumo': <><Steps rows={[
    ['Abra os resultados da análise', <>Comece pelos itens que indicam que precisam da sua atenção.</>],
    ['Leia a conclusão', <>Perceba exatamente o que a aplicação está a afirmar: obrigação, prazo, responsabilidade, sanção, referência ou outro ponto.</>],
    ['Abra a fonte e a citação', <>Confirme o documento, a página e o excerto que sustentam a conclusão.</>],
    ['Decida item a item', <>Mantenha apenas resultados que estejam corretos e devidamente sustentados.</>],
    ['Aprove o conjunto quando terminar', <>A aprovação permite gerar o Word apenas com os resultados válidos e aceites.</>],
  ]} /><Callout title="Não aprove apenas pelo texto da conclusão">A decisão deve ser feita depois de verificar a respetiva fonte.</Callout></>,

  'resultado-excluido': resultExcluded,
  'refazer-resultados': redoResults,
  'detalhes-analise': analysisDetails,
  'versoes-historico': analysisHistory,
  'aprovar-word': approveWord,
  'aprovar-pdf': approvePdf,
  'preparar-email': prepareEmail,

  // ---------------------------------------------------------------------------
  // Capítulo 3 — Revisão / Atualização
  // ---------------------------------------------------------------------------
  'criar-revisao': <Steps rows={[
    ['Abra Processos e escolha Nova análise', <>Inicie um novo processo a partir da lista de análises.</>],
    ['Escolha Revisão / Atualização', <>Este fluxo compara o documento principal com outras fontes relevantes e apresenta alterações para decisão.</>],
    ['Selecione o documento principal', <>Escolha o documento que pretende rever ou atualizar.</>],
    ['Confirme o conjunto de comparação', <>Selecione os documentos que devem ser considerados na revisão.</>],
    ['Reveja a configuração e inicie', <>Confirme as fontes antes de pedir à aplicação para efetuar a comparação.</>],
  ]} />,

  'confirmar-fontes-revisao': <><Steps rows={[
    ['Reveja os documentos relacionados propostos', <>A aplicação pode usar relações já confirmadas na Biblioteca para sugerir fontes de comparação.</>],
    ['Abra a justificação de cada sugestão', <>Confirme que o documento é realmente relevante para a revisão que está a fazer.</>],
    ['Confirme ou exclua cada documento', <>Só os documentos confirmados entram no conjunto de comparação.</>],
    ['Inicie a análise quando o conjunto estiver completo', <>Se faltar uma fonte importante, volte à Biblioteca e trate a relação antes de continuar.</>],
  ]} /><Callout title="A comparação depende das fontes escolhidas">Uma revisão pode ficar incompleta se um documento relevante ficar fora do conjunto confirmado.</Callout></>,

  'rever-resultados-revisao': <><Steps rows={[
    ['Abra as diferenças encontradas', <>Cada linha apresenta uma comparação entre o documento principal e as fontes confirmadas.</>],
    ['Leia a alteração e a respetiva prova', <>Abra as citações e confirme o que cada documento efetivamente diz.</>],
    ['Decida os pontos marcados “Requer a sua decisão”', <>Escolha Aceitar ou Rejeitar com base no conteúdo jurídico apresentado.</>],
    ['Distinga itens excluídos e não aplicáveis', <>Um item excluído falhou uma validação ou foi retirado; “Não aplicável” significa que não exigia uma decisão jurídica.</>],
    ['Aprove o conjunto depois de resolver todas as decisões', <>A aprovação permite avançar para a geração do Word.</>],
  ]} /><Callout title="A aplicação não toma a decisão jurídica por si">Os pontos que exigem decisão só avançam depois da sua escolha explícita.</Callout></>,

  'resultado-excluido-revisao': resultExcluded,
  'refazer-resultados-revisao': redoResults,

  'voltar-fase': <><Steps rows={[
    ['Abra Versões e histórico', <>Localize a etapa a partir da qual pretende refazer o trabalho.</>],
    ['Selecione a etapa e escolha “Voltar aqui”', <>A aplicação mostra apenas os destinos de regresso que são válidos.</>],
    ['Explique o que deve mudar', <>Dê uma instrução concreta para a nova tentativa.</>],
    ['Confirme o regresso', <>A aplicação cria uma nova ramificação e indica quais decisões terão de ser repetidas.</>],
  ]} /><Callout title="O percurso anterior permanece disponível">Voltar a uma fase não apaga resultados, decisões ou versões da tentativa anterior.</Callout></>,

  'detalhes-analise-revisao': analysisDetails,
  'versoes-historico-revisao': analysisHistory,
  'aprovar-word-revisao': approveWord,
  'aprovar-pdf-revisao': approvePdf,
  'preparar-email-revisao': prepareEmail,
};

export function HelpTopicBody({ sectionId }: { sectionId: string }) {
  return <div className="flex max-w-[92ch] flex-col gap-4 text-base leading-relaxed text-ink1">{HELP_TOPIC_BODIES[sectionId] || <p className="m-0">Este tópico de ajuda ainda não está disponível.</p>}</div>;
}

export function HelpTopicSection({ sectionId, highlighted = false, showGroup = true }: { sectionId: string; highlighted?: boolean; showGroup?: boolean }) {
  const topic = HELP_SECTIONS.find((item) => item.id === sectionId);
  return <section id={sectionId} data-help-section={sectionId} className={`scroll-mt-3 rounded-xl border px-6 py-5 ${highlighted ? 'border-accent bg-accent-ghost ring-2 ring-accent/25' : 'border-line0 bg-surface'}`}>
    {sectionId === 'templates' ? <span id="modelos" className="sr-only" aria-hidden /> : null}
    {topic && showGroup ? <p className="m-0 mb-1 text-xs font-semibold uppercase tracking-wide text-accent-strong">{topic.group}</p> : null}
    <h2 className="m-0 mb-3 font-heading text-2xl font-semibold text-ink0">{topic?.label || 'Ajuda'}</h2>
    <HelpTopicBody sectionId={sectionId} />
  </section>;
}

export function HelpSymbol() {
  return <CircleHelp aria-hidden className="h-5 w-5 shrink-0 text-accent-strong" />;
}
