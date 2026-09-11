export const TUTORIAL_KINDS = ['library', 'summary', 'revision'] as const;
export type TutorialKind = (typeof TUTORIAL_KINDS)[number];

export const TUTORIAL_SCREENS = [
  'home', 'library-roots', 'library-list', 'library-detail', 'relations', 'linked-analyses',
  'template-list', 'template-detail', 'template-editor', 'result-detail', 'analysis-type', 'analysis-source', 'analysis-support', 'analysis-review',
  'analysis-overview', 'findings', 'word', 'pdf', 'email', 'results', 'finish',
] as const;
export type TutorialScreen = (typeof TUTORIAL_SCREENS)[number];

export type TutorialStepMode = 'observe' | 'action' | 'input';

export type TutorialStep = {
  id: string;
  title: string;
  instruction: string;
  consequence: string;
  screen: TutorialScreen;
  target: string;
  /** Explicit in the API; legacy definitions infer it from whether an interaction exists. */
  mode?: TutorialStepMode;
  /** If present, the learner must operate the highlighted simulated control. */
  interaction?: { key: string; value: unknown };
  continueLabel?: string;
};

export type TutorialDefinition = {
  kind: TutorialKind;
  title: string;
  description: string;
  outcome: string;
  minutes: number;
  journey: readonly string[];
  steps: readonly TutorialStep[];
};

export const TUTORIAL_SCENARIO_VERSION = 6;

export function tutorialStepMode(step: TutorialStep): TutorialStepMode {
  return step.mode || (step.interaction ? 'action' : 'observe');
}

export function tutorialDefinition(kind: TutorialKind): TutorialDefinition {
  const definition = TUTORIALS[kind];
  return { ...definition, steps: definition.steps.map((step) => ({ ...step, mode: tutorialStepMode(step) })) };
}

export const TUTORIALS: Record<TutorialKind, TutorialDefinition> = {
  library: {
    kind: 'library',
    title: 'Biblioteca',
    description: 'Percorra a Biblioteca como no trabalho real: encontre uma fonte, leia o seu detalhe e prepare relações.',
    outcome: 'Saberá localizar um documento, interpretar o seu estado e preparar fontes para análises futuras.',
    minutes: 10,
    journey: ['Três pastas', 'Documento oficial', 'Template', 'Resultado', 'Proveniência'],
    steps: [
      { id: 'enter-library', title: 'Entre na Biblioteca', instruction: 'Neste treino, utiliza a aplicação normalmente sem alterar dados reais. Selecione “Biblioteca” no menu principal.', consequence: 'A Biblioteca organiza três tipos de conteúdo com funções diferentes.', screen: 'home', target: 'nav-library', interaction: { key: 'openedLibrary', value: true } },
      { id: 'three-roots', title: 'Conheça as três pastas principais', instruction: 'Leia o que pertence a Documentos oficiais, Templates e Resultados.', consequence: 'A pasta determina se um ficheiro é uma fonte, um Template ou uma saída da aplicação.', screen: 'library-roots', target: 'folders-overview', continueLabel: 'Compreendi as três pastas' },
      { id: 'open-officials', title: 'Comece pelos documentos oficiais', instruction: 'Abra a pasta que contém as fontes jurídicas e organizacionais.', consequence: 'Só estes documentos são lidos, classificados, relacionados e usados como fontes.', screen: 'library-roots', target: 'official-folder', interaction: { key: 'openedOfficialFolder', value: true } },
      { id: 'find-source', title: 'Encontre o documento', instruction: 'A pesquisa usa o nome e o título. Abra o documento de treino na lista.', consequence: 'O detalhe permite confirmar se é a fonte certa antes de iniciar trabalho.', screen: 'library-list', target: 'library-document', interaction: { key: 'openedDocument', value: true } },
      { id: 'understand-status', title: 'Veja o detalhe de um documento oficial', instruction: 'Leia o tipo, estado, assunto e páginas destacados nesta área.', consequence: 'Documentos oficiais têm metadados, texto, relações, análises e controlos de reprocessamento.', screen: 'library-detail', target: 'document-summary', continueLabel: 'Compreendi' },
      { id: 'open-preview', title: 'Use a pré-visualização real', instruction: 'Selecione “Pré-visualizar” para abrir a fonte no painel lateral da aplicação.', consequence: 'Pode consultar a fonte sem sair do contexto.', screen: 'library-detail', target: 'preview-button', interaction: { key: 'previewOpened', value: true } },
      { id: 'inspect-preview', title: 'Consulte o documento no mesmo contexto', instruction: 'O painel mantém o detalhe do documento acessível enquanto consulta a página original.', consequence: 'Pode fechar a pré-visualização e continuar no mesmo documento.', screen: 'library-detail', target: 'preview-panel', continueLabel: 'Compreendi' },
      { id: 'open-relations', title: 'Veja o trabalho pendente', instruction: 'O badge indica relações propostas por confirmar. Abra Relações.', consequence: 'Só relações confirmadas podem recomendar fontes de apoio numa análise.', screen: 'library-detail', target: 'relations-tab', interaction: { key: 'openedRelations', value: true } },
      { id: 'confirm-relation', title: 'Decida a relação', instruction: 'Leia motivo, confiança e relevância; depois confirme a relação simulada.', consequence: 'A fonte passaria a ser recomendada, mas continuaria a exigir confirmação individual.', screen: 'relations', target: 'confirm-relation', interaction: { key: 'relationDecision', value: 'confirmed' } },
      { id: 'open-analyses', title: 'Consulte as análises ligadas', instruction: 'Selecione o separador “Análises” deste documento oficial.', consequence: 'Aqui encontra o trabalho em que o documento participa e o papel que desempenha.', screen: 'library-detail', target: 'analyses-tab', interaction: { key: 'openedAnalyses', value: true } },
      { id: 'inspect-analyses', title: 'Leia o estado da análise', instruction: 'Esta área mostra o tipo de análise, o papel do documento e o estado atual do trabalho.', consequence: 'Pode abrir a análise ligada sem perder a proveniência documental.', screen: 'library-detail', target: 'analyses-list', continueLabel: 'Compreendi' },
      { id: 'return-library', title: 'Regresse à Biblioteca', instruction: 'Selecione “Biblioteca” para voltar às pastas principais.', consequence: 'O documento permanece inalterado e regressa à navegação da Biblioteca.', screen: 'library-detail', target: 'library-back', interaction: { key: 'returnedToLibrary', value: true } },
      { id: 'open-templates', title: 'Entre em Templates', instruction: 'Regresse à raiz simulada e abra a pasta Templates.', consequence: 'Aqui vivem os Templates usados por cada fluxo, sem serem tratados como fontes jurídicas.', screen: 'library-roots', target: 'template-folder', interaction: { key: 'openedTemplateFolder', value: true } },
      { id: 'template-kinds', title: 'Distinga e abra o Template certo', instruction: 'Na lista real, DOCX define o documento, EML define o e-mail e JSON define os campos. Abra o Template DOCX.', consequence: 'O detalhe do Template mostra a sua função e permite editá-lo.', screen: 'template-list', target: 'template-document', interaction: { key: 'templateOpened', value: true } },
      { id: 'edit-template', title: 'Faça ajustes simples na aplicação', instruction: 'Abra Editar para alterar blocos, texto fixo ou campos permitidos.', consequence: 'Guardar cria uma nova versão do template sem alterar documentos já produzidos.', screen: 'template-detail', target: 'edit-template', interaction: { key: 'templateEditorOpened', value: true } },
      { id: 'save-template', title: 'Experimente o editor simples', instruction: 'Guarde a alteração simulada neste bloco de texto.', consequence: 'O template passa a “Editado”; pode sempre restaurar a versão original.', screen: 'template-editor', target: 'save-template', interaction: { key: 'templateEdited', value: true } },
      { id: 'upload-template', title: 'Saiba como adicionar um Template novo', instruction: 'Um DOCX novo pode ser criado fora da aplicação e carregado nesta subpasta. Neste treino, apenas identifique o controlo.', consequence: 'A aplicação valida os campos e disponibiliza o Template no fluxo indicado pela pasta.', screen: 'template-detail', target: 'upload-template', continueLabel: 'Compreendi' },
      { id: 'open-results', title: 'Entre em Resultados', instruction: 'Abra a pasta que recebe os ficheiros produzidos pelas análises.', consequence: 'Cada análise guarda aqui Word, PDF final e dados extraídos na sua própria pasta.', screen: 'library-roots', target: 'results-folder', interaction: { key: 'openedResultsFolder', value: true } },
      { id: 'result-detail', title: 'Abra e veja o detalhe do Resultado', instruction: 'Abra o resultado produzido para consultar o tipo de saída, aprovação, versão e documento de origem.', consequence: 'Resultados não têm classificação nem relações: a proveniência é conhecida exatamente.', screen: 'results', target: 'result-document', interaction: { key: 'resultOpened', value: true } },
      { id: 'open-origin', title: 'Regresse à análise de origem', instruction: 'Abra a análise que produziu este resultado.', consequence: 'Na análise encontra o histórico, todas as versões e as aprovações humanas.', screen: 'result-detail', target: 'open-origin', interaction: { key: 'originOpened', value: true } },
      { id: 'finish', title: 'Biblioteca concluída', instruction: 'Terminou o percurso pelos três tipos de conteúdo.', consequence: 'A Biblioteca real permaneceu intacta durante toda a simulação.', screen: 'finish', target: 'finish-card', continueLabel: 'Concluir tutorial' },
    ],
  },
  summary: {
    kind: 'summary',
    title: 'Resumo documental',
    description: 'Faça um resumo completo numa réplica da aplicação, desde a fila de trabalho até ao resultado na Biblioteca.',
    outcome: 'Saberá escolher fontes, validar citações e aprovar Word, PDF e e-mail pela ordem correta.',
    minutes: 12,
    journey: ['Nova análise', 'Fontes', 'Resultados encontrados', 'Word', 'PDF', 'E-mail', 'Biblioteca'],
    steps: [
      { id: 'new-analysis', title: 'Comece na fila de trabalho', instruction: 'Selecione Nova análise, o ponto de entrada normal para criar trabalho.', consequence: 'A aplicação abre um percurso guiado e ainda não executa qualquer análise.', screen: 'home', target: 'new-analysis', interaction: { key: 'startedAnalysis', value: true } },
      { id: 'choose-type', title: 'Escolha o resultado', instruction: 'Escolha Resumo documental.', consequence: 'Esta escolha define os resultados a rever e o Template do documento final.', screen: 'analysis-type', target: 'choose-summary', interaction: { key: 'typeChosen', value: 'summary' } },
      { id: 'choose-main', title: 'Escolha a fonte principal', instruction: 'Abra o documento de treino na pesquisa por nome ou título.', consequence: 'A fonte principal determina o documento que será resumido.', screen: 'analysis-source', target: 'choose-main', interaction: { key: 'mainConfirmed', value: true } },
      { id: 'confirm-support', title: 'Confirme cada fonte de apoio', instruction: 'Confirme a recomendação baseada numa relação preparada.', consequence: 'Uma recomendação nunca entra automaticamente; a decisão continua a ser sua.', screen: 'analysis-support', target: 'confirm-support', interaction: { key: 'sourceConfirmed', value: true } },
      { id: 'start', title: 'Reveja antes de começar', instruction: 'Confirme o resultado e as fontes; depois inicie a análise simulada.', consequence: 'Na aplicação real, a extração começa apenas depois desta confirmação.', screen: 'analysis-review', target: 'start-analysis', interaction: { key: 'analysisStarted', value: true } },
      { id: 'open-work', title: 'Retome pela tarefa atual', instruction: 'A fila mostra o que precisa da sua decisão. Abra a análise.', consequence: 'O cartão principal explica o que fazer agora e o que acontece depois.', screen: 'analysis-overview', target: 'open-findings', interaction: { key: 'openedFindings', value: true } },
      { id: 'citation', title: 'Valide a citação', instruction: 'Abra a fonte da conclusão destacada para consultar o documento e a página indicados.', consequence: 'A fonte abre ao lado dos resultados.', screen: 'findings', target: 'open-citation', interaction: { key: 'citationOpened', value: true } },
      { id: 'inspect-citation', title: 'Compare a conclusão com a fonte', instruction: 'Leia o excerto e confirme que sustenta a conclusão antes de continuar.', consequence: 'Só resultados sustentados podem entrar no documento.', screen: 'findings', target: 'citation-preview', continueLabel: 'Citação verificada' },
      { id: 'exclusion', title: 'Compreenda a exclusão', instruction: 'Abra a área Excluídos para consultar o motivo de validação.', consequence: 'A conclusão fica no histórico, mas não entra no Word.', screen: 'findings', target: 'show-excluded', interaction: { key: 'excludedReviewed', value: true } },
      { id: 'approve-findings', title: 'Aprove os resultados encontrados', instruction: 'Depois de validar as citações, aprove este conjunto.', consequence: 'A aplicação fixa esta extração e prepara o documento Word.', screen: 'findings', target: 'approve-findings', interaction: { key: 'extractionApproved', value: true } },
      { id: 'open-history', title: 'Abra o histórico da análise', instruction: 'Selecione Histórico para ver o percurso que acabou de construir, sem sair da análise.', consequence: 'O histórico organiza as decisões e artefactos por tentativa.', screen: 'word', target: 'history-tab', interaction: { key: 'historyOpened', value: true } },
      { id: 'inspect-history', title: 'Leia o percurso completo', instruction: 'Observe a sequência desde a configuração até ao documento criado e repare que cada etapa conserva o respetivo rasto.', consequence: 'Pode consultar qualquer momento sem alterar a tentativa em uso.', screen: 'word', target: 'history-graph', continueLabel: 'Percebi o percurso' },
      { id: 'select-stage', title: 'Abra uma etapa anterior', instruction: 'Selecione o nó da Extração para consultar o que aconteceu nesse ponto.', consequence: 'O detalhe permite regressar a uma etapa sem apagar o percurso atual.', screen: 'word', target: 'history-graph', interaction: { key: 'stageSelected', value: true } },
      { id: 'return-stage', title: 'Pratique “Voltar aqui”', instruction: 'Selecione Voltar aqui para preparar uma alternativa a partir da Extração.', consequence: 'A tentativa original fica guardada e será criada uma ramificação.', screen: 'word', target: 'return-here', interaction: { key: 'returnRequested', value: true } },
      { id: 'describe-restart', title: 'Explique o que pretende refazer', instruction: 'Edite a indicação, se necessário, e crie a nova tentativa.', consequence: 'A orientação fica registada no histórico e só as etapas seguintes são repetidas.', screen: 'word', target: 'restart-guidance', mode: 'input', interaction: { key: 'branchCreated', value: true } },
      { id: 'inspect-branch', title: 'Confirme a nova ramificação', instruction: 'Observe como o Histórico mantém o percurso A e mostra a nova tentativa B ligada ao ponto de regresso.', consequence: 'Consultar uma tentativa não a torna automaticamente ativa.', screen: 'word', target: 'history-graph', continueLabel: 'Vejo as duas tentativas' },
      { id: 'redo-chat', title: 'Peça uma correção no chat', instruction: 'Escreva ou ajuste o pedido e envie-o no campo de conversa da análise.', consequence: 'A aplicação explica o impacto antes de criar outra versão.', screen: 'word', target: 'chat-composer', mode: 'input', interaction: { key: 'chatSent', value: true } },
      { id: 'confirm-chat', title: 'Confirme a alteração proposta', instruction: 'Leia a resposta e confirme a alteração para aplicar o pedido à tentativa atual.', consequence: 'Uma nova versão fica associada ao pedido e ao utilizador que o confirmou.', screen: 'word', target: 'confirm-chat', interaction: { key: 'chatConfirmed', value: true } },
      { id: 'view-original', title: 'Consulte o percurso original', instruction: 'No Histórico, escolha consultar o percurso A.', consequence: 'Está apenas a consultar; a tentativa B continua em uso.', screen: 'word', target: 'history-graph', interaction: { key: 'originalViewed', value: true } },
      { id: 'activate-original', title: 'Ative o percurso consultado', instruction: 'Selecione Passar a trabalhar nesta tentativa para tornar o percurso A ativo.', consequence: 'Ativar é uma decisão separada de consultar e fica visível no cabeçalho.', screen: 'word', target: 'activate-path', interaction: { key: 'originalActivated', value: true } },
      { id: 'view-branch', title: 'Volte a consultar a tentativa corrigida', instruction: 'Escolha consultar o percurso B, onde ficou guardada a correção feita no chat.', consequence: 'Pode comparar tentativas antes de escolher qual continuar.', screen: 'word', target: 'history-graph', interaction: { key: 'branchViewed', value: true } },
      { id: 'activate-branch', title: 'Continue na tentativa corrigida', instruction: 'Ative a tentativa B para continuar a aprovação dos resultados corrigidos.', consequence: 'As aprovações seguintes ficam associadas à tentativa B.', screen: 'word', target: 'activate-path', interaction: { key: 'branchActivated', value: true } },
      { id: 'open-word', title: 'Abra o documento Word', instruction: 'Na conversa, selecione Pré-visualizar no cartão do documento Word.', consequence: 'O documento abre no painel lateral sem perder a conversa.', screen: 'word', target: 'open-word', interaction: { key: 'wordOpened', value: true } },
      { id: 'inspect-word', title: 'Reveja o Word completo', instruction: 'Percorra a página A4 e confirme estrutura, conteúdo e citações antes de aprovar.', consequence: 'Fechar o painel devolve-o ao mesmo cartão da conversa.', screen: 'word', target: 'artifact-preview', continueLabel: 'Word revisto' },
      { id: 'approve-word', title: 'Aprove o Word', instruction: 'Selecione Aprovar documento Word no respetivo cartão.', consequence: 'A aprovação desbloqueia a produção do PDF.', screen: 'word', target: 'approve-word', interaction: { key: 'wordApproved', value: true } },
      { id: 'open-pdf', title: 'Abra o PDF produzido', instruction: 'Selecione Abrir no cartão do PDF final.', consequence: 'O PDF abre no painel usado na aplicação real.', screen: 'pdf', target: 'open-pdf', interaction: { key: 'pdfOpened', value: true } },
      { id: 'inspect-pdf', title: 'Confirme a paginação', instruction: 'Percorra o PDF e verifique que corresponde ao Word aprovado.', consequence: 'Só depois deve autorizar a preparação do e-mail.', screen: 'pdf', target: 'artifact-preview', continueLabel: 'PDF revisto' },
      { id: 'approve-pdf', title: 'Aprove o PDF final', instruction: 'Selecione Aprovar PDF final no cartão do PDF.', consequence: 'O rascunho de e-mail fica disponível após esta confirmação humana.', screen: 'pdf', target: 'approve-pdf', interaction: { key: 'pdfApproved', value: true } },
      { id: 'open-email', title: 'Abra o rascunho de e-mail', instruction: 'Selecione Abrir e editar no cartão de e-mail.', consequence: 'Destinatários, assunto, mensagem e anexo ficam disponíveis no painel.', screen: 'email', target: 'open-email', interaction: { key: 'emailOpened', value: true } },
      { id: 'edit-email', title: 'Guarde os dados da entrega', instruction: 'Confirme ou ajuste os campos e selecione Guardar alterações.', consequence: 'Guardar atualiza apenas o rascunho; ainda não envia nada.', screen: 'email', target: 'save-email', mode: 'input', interaction: { key: 'emailSaved', value: true } },
      { id: 'approve-email', title: 'Aprove o e-mail', instruction: 'Selecione Aprovar e-mail para concluir a análise sem iniciar qualquer descarga.', consequence: 'A decisão fica registada e o ficheiro .eml passa a estar disponível separadamente.', screen: 'email', target: 'approve-email', interaction: { key: 'emailApproved', value: true } },
      { id: 'prepare-email', title: 'Descarregue o rascunho', instruction: 'No cartão da análise, descarregue agora o ficheiro .eml.', consequence: 'A aplicação cria um ficheiro para abrir no Outlook; nunca envia em seu nome.', screen: 'email', target: 'download-email', interaction: { key: 'emailReviewed', value: true } },
      { id: 'locate-result', title: 'Encontre o resultado', instruction: 'Abra o resultado produzido na Biblioteca simulada.', consequence: 'O detalhe mostra a análise de origem, o tipo, a aprovação e a versão.', screen: 'results', target: 'result-document', interaction: { key: 'resultLocated', value: true } },
      { id: 'finish', title: 'Resumo concluído', instruction: 'Terminou o percurso completo que encontrará na aplicação.', consequence: 'Nenhuma análise, versão, mensagem ou ficheiro real foi criado.', screen: 'finish', target: 'finish-card', continueLabel: 'Concluir tutorial' },
    ],
  },
  revision: {
    kind: 'revision',
    title: 'Revisão / Atualização',
    description: 'Faça uma revisão completa, tome decisões jurídicas e pratique a rejeição de uma tentativa numa réplica da aplicação.',
    outcome: 'Saberá comparar fontes, resolver decisões pendentes, refazer uma extração e aprovar a entrega.',
    minutes: 14,
    journey: ['Nova análise', 'Fontes', 'Comparação', 'Decisões', 'Nova tentativa', 'Word', 'PDF', 'E-mail'],
    steps: [
      { id: 'new-analysis', title: 'Comece na fila de trabalho', instruction: 'Selecione Nova análise.', consequence: 'O assistente abre a configuração; ainda nada é analisado.', screen: 'home', target: 'new-analysis', interaction: { key: 'startedAnalysis', value: true } },
      { id: 'choose-type', title: 'Escolha o resultado', instruction: 'Escolha Revisão / Atualização.', consequence: 'A aplicação irá comparar a fonte principal com fontes de apoio confirmadas.', screen: 'analysis-type', target: 'choose-revision', interaction: { key: 'typeChosen', value: 'revision' } },
      { id: 'choose-main', title: 'Escolha o documento a rever', instruction: 'Selecione o documento de treino como fonte principal.', consequence: 'Este é o texto cuja atualidade será avaliada.', screen: 'analysis-source', target: 'choose-main', interaction: { key: 'mainConfirmed', value: true } },
      { id: 'confirm-support', title: 'Confirme a base de comparação', instruction: 'Confirme individualmente a fonte de apoio recomendada.', consequence: 'Relevância sem confirmação nunca transforma uma sugestão em fonte.', screen: 'analysis-support', target: 'confirm-support', interaction: { key: 'sourceConfirmed', value: true } },
      { id: 'start', title: 'Inicie a revisão', instruction: 'Reveja a seleção e inicie a análise simulada.', consequence: 'A aplicação prepara uma matriz; não toma decisões jurídicas por si.', screen: 'analysis-review', target: 'start-analysis', interaction: { key: 'analysisStarted', value: true } },
      { id: 'open-work', title: 'Abra a tarefa pendente', instruction: 'Entre em Rever resultados encontrados.', consequence: 'A vista abre diretamente nas linhas que precisam da sua decisão.', screen: 'analysis-overview', target: 'open-findings', interaction: { key: 'openedFindings', value: true } },
      { id: 'citation', title: 'Compare com a fonte', instruction: 'Abra a citação para consultar a redação usada na comparação.', consequence: 'A fonte abre ao lado da matriz.', screen: 'findings', target: 'open-citation', interaction: { key: 'citationOpened', value: true } },
      { id: 'inspect-citation', title: 'Leia a redação lado a lado', instruction: 'Compare a alteração proposta com o documento, a página e o excerto apresentados.', consequence: 'A decisão jurídica fica apoiada na fonte exata.', screen: 'findings', target: 'citation-preview', continueLabel: 'Comparação feita' },
      { id: 'legal-decision', title: 'Tome a decisão jurídica', instruction: 'Aceite a alteração assinalada.', consequence: 'Enquanto uma linha exigir decisão, a aprovação do conjunto fica bloqueada.', screen: 'findings', target: 'accept-legal', interaction: { key: 'legalDecision', value: 'accepted' } },
      { id: 'open-history', title: 'Abra o Histórico', instruction: 'Selecione Histórico para ver onde a comparação e a decisão ficaram registadas.', consequence: 'Pode regressar a uma fase anterior sem destruir esta tentativa.', screen: 'findings', target: 'history-tab', interaction: { key: 'historyOpened', value: true } },
      { id: 'inspect-history', title: 'Leia o percurso jurídico', instruction: 'Observe a sequência da configuração, extração e revisão, incluindo a decisão humana.', consequence: 'O rasto distingue o que a aplicação encontrou do que o jurista decidiu.', screen: 'findings', target: 'history-graph', continueLabel: 'Percebi o percurso' },
      { id: 'select-stage', title: 'Abra a Extração anterior', instruction: 'Selecione o nó da Extração para consultar esse momento.', consequence: 'O painel mostra o que pode ser retomado e o que ficará preservado.', screen: 'findings', target: 'history-graph', interaction: { key: 'stageSelected', value: true } },
      { id: 'return-stage', title: 'Volte à etapa escolhida', instruction: 'Selecione Voltar aqui para refazer o trabalho a partir da Extração.', consequence: 'A tentativa A fica imutável e nasce uma tentativa B.', screen: 'findings', target: 'return-here', interaction: { key: 'returnRequested', value: true } },
      { id: 'describe-restart', title: 'Dê orientação à nova tentativa', instruction: 'Ajuste o motivo e crie a nova tentativa.', consequence: 'A decisão anterior não é copiada: terá de ser tomada novamente.', screen: 'findings', target: 'restart-guidance', mode: 'input', interaction: { key: 'branchCreated', value: true } },
      { id: 'inspect-branch', title: 'Veja as duas tentativas', instruction: 'Confirme no Histórico que A foi preservada e B começa no ponto escolhido.', consequence: 'Cada percurso mantém as suas próprias decisões, versões e aprovações.', screen: 'findings', target: 'history-graph', continueLabel: 'Vejo a ramificação' },
      { id: 'redo-chat', title: 'Refaça diretamente pelo chat', instruction: 'Escreva ou ajuste a correção jurídica e envie o pedido.', consequence: 'A aplicação responde com o impacto e pede confirmação antes de alterar o documento.', screen: 'word', target: 'chat-composer', mode: 'input', interaction: { key: 'chatSent', value: true } },
      { id: 'confirm-chat', title: 'Confirme o pedido jurídico', instruction: 'Leia o impacto apresentado e confirme a alteração.', consequence: 'A nova versão fica ligada ao pedido confirmado.', screen: 'word', target: 'confirm-chat', interaction: { key: 'chatConfirmed', value: true } },
      { id: 'view-original', title: 'Compare com o percurso original', instruction: 'No Histórico, escolha consultar o percurso A.', consequence: 'Consultar não muda a tentativa ativa.', screen: 'word', target: 'history-graph', interaction: { key: 'originalViewed', value: true } },
      { id: 'activate-original', title: 'Pratique ativar um percurso', instruction: 'Ative o percurso A que está a consultar.', consequence: 'O cabeçalho passa a indicar que A está em uso.', screen: 'word', target: 'activate-path', interaction: { key: 'originalActivated', value: true } },
      { id: 'view-branch', title: 'Regresse à tentativa revista', instruction: 'Escolha consultar o percurso B para recuperar a correção.', consequence: 'Pode alternar a consulta sem perder nenhuma tentativa.', screen: 'word', target: 'history-graph', interaction: { key: 'branchViewed', value: true } },
      { id: 'activate-branch', title: 'Ative a tentativa B', instruction: 'Passe a trabalhar na tentativa B antes de continuar.', consequence: 'As decisões e aprovações seguintes pertencem ao percurso corrigido.', screen: 'word', target: 'activate-path', interaction: { key: 'branchActivated', value: true } },
      { id: 'decide-retry', title: 'Repita a decisão jurídica', instruction: 'Na nova tentativa, aceite novamente a alteração assinalada.', consequence: 'Decisões do percurso A não são copiadas silenciosamente para B.', screen: 'findings', target: 'accept-legal', interaction: { key: 'legalDecisionRetry', value: 'accepted' } },
      { id: 'approve-findings', title: 'Aprove a comparação', instruction: 'Aprove o novo conjunto de resultados.', consequence: 'A versão Word pode agora ser preparada.', screen: 'findings', target: 'approve-findings', interaction: { key: 'extractionApproved', value: true } },
      { id: 'open-word', title: 'Abra o Word revisto', instruction: 'Selecione Pré-visualizar no cartão do documento Word.', consequence: 'A versão da tentativa B abre ao lado da conversa.', screen: 'word', target: 'open-word', interaction: { key: 'wordOpened', value: true } },
      { id: 'inspect-word', title: 'Compare o documento completo', instruction: 'Percorra a página A4 e confirme que a decisão jurídica foi aplicada com a fonte correta.', consequence: 'A versão só avança quando a revisão humana termina.', screen: 'word', target: 'artifact-preview', continueLabel: 'Word revisto' },
      { id: 'approve-word', title: 'Aprove o Word', instruction: 'Selecione Aprovar documento Word no cartão da conversa.', consequence: 'Esta confirmação desbloqueia o PDF.', screen: 'word', target: 'approve-word', interaction: { key: 'wordApproved', value: true } },
      { id: 'open-pdf', title: 'Abra o PDF final', instruction: 'Selecione Abrir no cartão do PDF produzido.', consequence: 'Pode comparar o resultado final sem sair da análise.', screen: 'pdf', target: 'open-pdf', interaction: { key: 'pdfOpened', value: true } },
      { id: 'inspect-pdf', title: 'Reveja o PDF página a página', instruction: 'Confirme a paginação e a correspondência com o Word aprovado.', consequence: 'O e-mail continua bloqueado até à aprovação.', screen: 'pdf', target: 'artifact-preview', continueLabel: 'PDF revisto' },
      { id: 'approve-pdf', title: 'Aprove o PDF', instruction: 'Selecione Aprovar PDF final no respetivo cartão.', consequence: 'Só então a aplicação prepara o e-mail.', screen: 'pdf', target: 'approve-pdf', interaction: { key: 'pdfApproved', value: true } },
      { id: 'open-email', title: 'Abra o rascunho de e-mail', instruction: 'Selecione Abrir e editar no cartão da conversa.', consequence: 'O painel apresenta destinatários, assunto, mensagem e o PDF anexo.', screen: 'email', target: 'open-email', interaction: { key: 'emailOpened', value: true } },
      { id: 'edit-email', title: 'Guarde o rascunho', instruction: 'Confirme ou ajuste os campos e selecione Guardar alterações.', consequence: 'Guardar não envia a mensagem.', screen: 'email', target: 'save-email', mode: 'input', interaction: { key: 'emailSaved', value: true } },
      { id: 'approve-email', title: 'Aprove o e-mail', instruction: 'Selecione Aprovar e-mail para concluir a análise sem descarregar o ficheiro.', consequence: 'A aprovação e a descarga ficam registadas como ações distintas.', screen: 'email', target: 'approve-email', interaction: { key: 'emailApproved', value: true } },
      { id: 'prepare-email', title: 'Descarregue o e-mail', instruction: 'Descarregue agora o rascunho .eml no cartão da análise.', consequence: 'O rascunho abre no Outlook para decisão e envio humanos.', screen: 'email', target: 'download-email', interaction: { key: 'emailReviewed', value: true } },
      { id: 'finish', title: 'Revisão concluída', instruction: 'Terminou o percurso completo, incluindo uma nova tentativa.', consequence: 'Todo o treino ficou isolado dos documentos e processos reais.', screen: 'finish', target: 'finish-card', continueLabel: 'Concluir tutorial' },
    ],
  },
};

export function isTutorialKind(value: unknown): value is TutorialKind {
  return typeof value === 'string' && (TUTORIAL_KINDS as readonly string[]).includes(value);
}
