// Every sentence the analysis workflow shows a user, in one place, in pt-PT.
//
// The point is not tidiness: a blocker message, the disabled reason on a button and the
// 409 body of the endpoint that refuses the same action are THE SAME STRING, because they
// are the same message id. That is what stops the UI and the API from drifting apart, as
// they did while each branch carried its own wording.
//
// Placeholders are {name}; msg() interpolates and leaves an unknown key untouched so a
// missing parameter is visible rather than silently blank.

export const MESSAGES = {
  // --- phase headlines: the one sentence under the stepper -----------------------------
  'phase.configuracao.headline.revision':
    'Vamos identificar os documentos relacionados com o documento principal.',
  'phase.configuracao.headline.summary': 'Tudo pronto para processar o documento.',
  'phase.configuracao.headline.confirm':
    'Confirme ou exclua cada documento relacionado — só documentos confirmados podem ser citados.',
  'phase.extracao.headline.summary': 'A extrair as afirmações do documento principal…',
  'phase.extracao.headline.revision': 'A construir a matriz comparativa com os documentos confirmados…',
  'phase.revisao.headline': 'Reveja o resultado da extração e aprove-o para eu escrever o documento.',
  'phase.documento.headline': 'Reveja o documento. Pode editá-lo aqui ou pedir-me alterações no chat.',
  'phase.pdf.headline': 'Reveja o PDF como vai ser enviado e aprove-o.',
  'phase.email.headline': 'Reveja o rascunho de e-mail. Pode editá-lo aqui ou pedir-me alterações.',
  'phase.email.headline.closed': 'Análise concluída. O e-mail foi aprovado com o PDF em anexo.',

  // --- state headlines that are not a phase --------------------------------------------
  'state.em_processamento.headline': 'A trabalhar…',
  'state.a_identificar_relacoes.headline': 'A identificar documentos relacionados…',
  'state.alteracao_pendente.headline':
    'Esta alteração precisa da sua confirmação explícita antes de eu a aplicar.',
  'error.failed':
    'Falhei na fase "{phase}": {detail}. Nada do que já estava validado se perdeu — pode tentar de novo.',
  'state.erro.headline': 'Falhei na fase "{phase}": {detail}. Nada do que já estava validado se perdeu.',
  'state.eliminada.headline':
    'Esta análise foi eliminada. O histórico continua disponível para consulta, mas nada pode ser alterado.',

  // --- action labels --------------------------------------------------------------------
  'action.identify_relations.label': 'Identificar documentos relacionados',
  'action.identify_relations.busy': 'A identificar…',
  'action.run.label': 'Processar análise',
  'action.run.label.revision': 'Construir a matriz comparativa',
  'action.run.busy': 'A processar…',
  'action.run.retry': 'Tentar processar de novo',
  'action.approve_extraction.label': 'Aprovar extração',
  'action.approve_extraction.busy': 'A aprovar…',
  'action.generate_version.label': 'Gerar documento',
  'action.generate_version.again': 'Gerar nova versão',
  'action.generate_version.busy': 'A gerar…',
  'action.set_final.label': 'Aprovar este documento',
  'action.set_final.busy': 'A fixar…',
  'action.approve_pdf.label': 'Aprovar este PDF',
  'action.approve_pdf.busy': 'A aprovar…',
  'action.retry_conversion.label': 'Repetir conversão',
  'action.approve_email.label': 'Aprovar e-mail',
  'action.track_back.label': '↩ Recomeçar numa fase anterior',
  'action.open_settings.label': 'Abrir Definições',

  // --- blockers: why the phase's exit is closed ----------------------------------------
  // Each is thrown by the endpoint AND shown as the disabled reason on the button.
  'block.state': 'Esta ação não é possível no estado "{state}".',
  'block.documents_pending':
    'Confirme ou exclua todos os documentos relacionados — só documentos confirmados podem ser citados ({n} por decidir).',
  'block.no_confirmed_related':
    'Uma revisão precisa de pelo menos um documento relacionado confirmado.',
  'block.ai_required.run':
    'Não consigo avançar sem a ligação à IA: a extração de obrigações e prazos não tem substituto determinístico. Ligue o ChatGPT nas Definições.',
  'block.ai_required.chat':
    'Não consigo processar este pedido sem a ligação à IA — o chat de revisão reescreve o documento e isso não tem substituto determinístico. Ligue o ChatGPT nas Definições.',
  'block.no_items': 'Não há itens validados para gerar o documento.',
  'block.legal_decisions': '{n} linha(s) exigem uma decisão jurídica antes de continuar.',
  'block.extraction_missing': 'Ainda não existe uma extração para rever.',
  'block.extraction_not_approved': 'Aprove primeiro o resultado da extração.',
  'block.no_version': 'Ainda não existe um documento gerado.',
  'block.no_final_version': 'Ainda não aprovou nenhuma versão do documento.',
  'block.conversion_running': 'A conversão para PDF ainda está a decorrer.',
  'block.conversion_failed': 'A conversão para PDF falhou: {detail}',
  'block.pdf_stale': 'O PDF está desatualizado — foi criada uma versão mais recente do documento.',
  'block.pdf_not_approved': 'O PDF ainda não foi aprovado.',
  'block.pdf_hash_mismatch': 'O PDF não corresponde ao documento final. Repita a conversão.',
  'block.pending_change': 'Confirme ou descarte a alteração pendente antes de pedir outra.',
  'block.not_active_path':
    'Está a ver o caminho {path}. O trabalho decorre no caminho {activePath} — escolha este caminho para continuar aqui.',
  'block.busy': 'Há uma operação a decorrer nesta análise.',
  'block.writes': 'Não é possível alterar nada enquanto {reason}',
  'block.writes.pending': 'houver uma alteração por confirmar.',
  'block.writes.busy': 'o agente estiver a trabalhar.',
  'block.writes.closed': 'a análise estiver concluída.',
  'block.writes.other_path': 'estiver a ver outro caminho.',
  'block.closed': 'Esta análise está concluída. Para a retomar, recomece a partir de uma fase anterior.',

  // --- notices: true, relevant, and NOT blocking ----------------------------------------
  'notice.ai_degraded.relations':
    'A IA não está ligada. Propus os documentos relacionados só com as evidências que a própria aplicação encontrou — pode faltar contexto e os tipos propostos são os mais conservadores.',
  'notice.ai_degraded.narrative':
    'A IA não está ligada. Escrevi o documento de forma determinística: os itens validados agrupados por tipo, sem redação. O conteúdo é o mesmo; o texto é mais seco.',
  'notice.potentially_affected': '{reason}',
  'notice.viewing_other_path':
    'Está a ver o caminho {path}. O trabalho decorre no caminho {activePath}.',
  'notice.closed':
    'Análise concluída. Para a retomar, recomece a partir de uma fase anterior no Histórico — isso cria um caminho novo e deixa este intacto.',
  'notice.converting': 'A converter o documento em PDF…',
  'notice.generating': 'A escrever o documento a partir dos itens validados…',
  'notice.interrupted':
    'O processamento foi interrompido — a aplicação reiniciou ou a ligação caiu. Nada do que já estava validado se perdeu.',

  // --- the user's own turns, so the exchange has two sides ------------------------------
  'chat.user.request': 'Analisa o documento "{document}".',
  'chat.user.request.related': ' Usa também {n} documento(s) relacionado(s) que escolhi.',
  'chat.user.request.instructions': ' Deixei instruções sobre o que quero.',
  'chat.user.documents.confirmed': 'Confirmei {n} documento(s) para usares.',
  'chat.user.documents.excluded': 'Excluí {n} documento(s) — não os uses.',
  'chat.user.documents.both': 'Confirmei {confirmed} documento(s) e excluí {excluded}.',
  'chat.user.items.accepted': 'Revi a extração e aceitei {n} item(ns).',
  'chat.user.items.both': 'Revi a extração: aceitei {accepted} item(ns) e rejeitei {rejected}.',

  // --- the agent's narration of what happened -------------------------------------------
  'event.created': 'Recebi o pedido e vou trabalhar sobre "{document}".',
  'event.created.related': ' Vou considerar também {n} documento(s) relacionado(s) que selecionou.',
  'event.created.instructions': ' Tenho em conta as instruções que deixou.',
  'event.relations_identified':
    'Encontrei {n} documento(s) que podem estar relacionados. Confirme quais devo usar — só documentos confirmados podem ser citados.',
  'event.relations_identified.none':
    'Não encontrei documentos relacionados com evidência suficiente para propor.',
  'event.run_started': 'Comecei a processar.',
  'event.run_completed': 'Terminei a extração: {accepted} item(ns) validados.',
  'event.run_completed.rejected':
    'Terminei a extração: {accepted} item(ns) validados e {rejected} rejeitado(s) pelos validadores de citações (fonte inexistente, página errada ou excerto que não confere).',
  'event.run_refused': 'Não consegui avançar: a ligação à IA não está configurada nas Definições.',
  'event.extraction_approved': 'Aprovei a extração.',
  'event.extraction_rejected': 'Rejeitei estes resultados e pedi uma nova tentativa.',
  'event.extraction_edited': 'Editei a extração e guardei-a como uma versão nova.',
  'event.approved': 'Análise aprovada.',
  'event.version_generated': 'Escrevi o documento a partir dos itens validados.',
  'event.version_set_final': 'Aprovei o documento Word.',
  'event.version_edited_in_app': 'Editei o documento Word e guardei-o como uma versão nova.',
  'event.pdf_approved': 'Aprovei o PDF final.',
  'event.pdf_conversion_failed':
    'Não consegui converter o documento em PDF porque {cause}. O documento Word ficou intacto — podemos tentar de novo.',
  'event.email_draft_created': 'Preparei o rascunho de e-mail com o PDF aprovado em anexo ({pdfName}).',
  'event.email_draft_edited': 'Editei o e-mail.',
  'event.email_approved': 'Aprovei o e-mail.',
  'event.analysis_closed': 'Análise concluída — o e-mail foi aprovado com o PDF final em anexo.',
  'event.analysis_reopened': 'A análise estava concluída e foi reaberta — o trabalho continua a partir daqui.',
  'event.potentially_affected': 'Atenção: {reason}',
  'event.narrative_markers_stripped':
    'Removi {stripped} marcador(es) de referência inválido(s) do texto — só cito fontes verificadas.',
  'event.tracked_back': 'Quero recomeçar na fase "{phase}". Continuamos no caminho {path}.',
  'event.path_forked':
    'Criei um novo caminho ({path}) a partir da versão {fromVersion} — o caminho anterior fica intacto.',
  'event.error': 'Não consegui concluir a fase "{phase}" porque {cause}.',
  // Retries of one operation are ONE thing that went wrong, said once, with how many times.
  'event.failure.repeated': ' Tentei {n} vezes.',
  'event.failure.remedy': ' {remedy}',
  'event.items_discarded':
    'Apaguei os {n} item(ns) da extração anterior e as decisões que tinha tomado sobre eles.',

  // --- the artifact cards in the chat ----------------------------------------------------
  'card.extraction.title': 'Extração',
  'card.extraction.counts': '{accepted} validado(s) · {rejected} rejeitado(s) pelos validadores',
  'card.extraction.open': 'Rever e aprovar',
  'card.extraction.approved': 'Aprovada',
  'card.extraction.superseded': 'Substituída por {by}',
  'card.document.title': 'Documento Word',
  'card.document.superseded': 'Substituído por {by}',
  'card.pdf.title': 'PDF final',
  'card.pdf.meta': '{pages} página(s) · {size}',
  'card.pdf.open': 'Ver PDF',
  'card.pdf.data': 'Descarregar dados (JSON)',
  'card.pdf.superseded': 'Substituído por uma versão mais recente',
  'card.email.title': 'E-mail',
  'card.email.open': 'Editar e-mail',
  'card.expand': 'Ver detalhes',

  // --- short labels for the history graph's node cards ----------------------------------
  'node.created': 'Análise criada',
  'node.relations_identified': 'Relações identificadas',
  'node.run_completed': 'Análise processada',
  'node.run_refused': 'Processamento recusado',
  'node.extraction_approved': 'Extração aprovada',
  'node.extraction_rejected': 'Resultados rejeitados',
  'node.approved': 'Análise aprovada',
  'node.version_set_final': 'Documento Word aprovado',
  'node.pdf_approved': 'PDF final aprovado',
  'node.pdf_conversion_failed': 'Conversão falhou',
  'node.email_draft_created': 'Rascunho de e-mail',
  'node.email_approved': 'E-mail aprovado',
  'node.analysis_closed': 'Análise concluída',
  'node.analysis_reopened': 'Análise reaberta',
  'node.tracked_back': 'Recomeço a partir daqui',
  'node.path_forked': 'Novo caminho',
  'node.potentially_affected': 'Fonte alterada',
  'node.error': 'Falhou',

  // --- track-back: the fixed question per phase ------------------------------------------
  'trackback.configuracao.prompt':
    'Vamos recomeçar a partir da configuração. O que deve mudar no âmbito da análise? Indique, por exemplo, documentos relacionados a incluir ou excluir, o foco pretendido, ou restrições a respeitar.',
  'trackback.configuracao.placeholder':
    'Ex.: incluir também o Regulamento do Canal de Denúncia; focar nas obrigações de reporte.',
  'trackback.extracao.summary.prompt':
    'Vamos repetir a extração. Que tipos de conteúdo devem ser privilegiados ou tratados de forma diferente? Indique, por exemplo, obrigações a não perder, secções a ignorar, ou o nível de detalhe desejado.',
  'trackback.extracao.summary.placeholder':
    'Ex.: extrair também as definições; ignorar os anexos; mais detalhe nos prazos.',
  'trackback.extracao.revision.prompt':
    'Vamos reconstruir a matriz comparativa. Que critérios de comparação devem mudar? Indique, por exemplo, tópicos a cobrir obrigatoriamente, o tipo de propostas de alteração pretendido, ou pontos a ignorar.',
  'trackback.extracao.revision.placeholder':
    'Ex.: comparar apenas âmbito e sanções; propor alterações conservadoras.',
  'trackback.revisao.prompt':
    'Vamos rever de novo os itens validados. Que decisões devem ser reconsideradas e com que critério? Indique o que aceitar, rejeitar ou tratar com mais cuidado.',
  'trackback.revisao.placeholder': 'Ex.: rejeitar sugestões da IA; aceitar apenas itens com fonte direta.',
  'trackback.documento.prompt':
    'Vamos gerar o documento de outra forma. Como deve ficar? Indique estrutura, tom, extensão ou secções a incluir/excluir.',
  'trackback.documento.placeholder':
    'Ex.: mais conciso, com uma secção final de recomendações; tom formal.',
  'trackback.pdf.prompt':
    'Vamos preparar de novo a versão final e o PDF. O que deve ser corrigido antes de fixar a versão final?',
  'trackback.pdf.placeholder': 'Ex.: corrigir o título; retirar a secção 4 antes de fixar como final.',
  'trackback.email.prompt':
    'Vamos preparar de novo o envio. O que deve mudar no documento antes de gerar o rascunho de e-mail?',
  'trackback.email.placeholder': 'Ex.: acrescentar nota introdutória; rever o anexo de fontes.',

  // --- the consequence of reverting, written before the user commits --------------------
  'trackback.consequence.forks':
    'Já existe um documento nesta análise. Recomeçar cria o caminho {next} — o caminho {current} fica intacto e pode voltar a ele no Histórico.',
  'trackback.consequence.same_path':
    'Ainda não existe nenhum documento nesta análise. Recomeçar continua no caminho {current} — não há trabalho anterior a preservar.',
  'trackback.consequence.loses_items':
    'Recomeçar aqui substitui os {n} item(ns) validados e as decisões que tomou sobre eles — vou extrair tudo de novo.',
} as const;

export type MessageId = keyof typeof MESSAGES;
export type MessageParams = Record<string, string | number>;

/** Render a message. Unknown placeholders stay visible rather than becoming blank. */
export function msg(id: MessageId, params?: MessageParams): string {
  const template = MESSAGES[id] as string;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in params ? String(params[key]) : whole,
  );
}

export function isMessageId(value: string): value is MessageId {
  return Object.prototype.hasOwnProperty.call(MESSAGES, value);
}
