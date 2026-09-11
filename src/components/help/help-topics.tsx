'use client';

import type { ReactNode } from 'react';
import { CircleHelp } from 'lucide-react';

import { HELP_SECTIONS } from '@/lib/help-contexts';

function Callout({ title, children, tone = 'accent' }: { title: string; children: ReactNode; tone?: 'accent' | 'warning' }) {
  return <div className={`rounded-lg border-l-4 px-5 py-4 ${tone === 'warning' ? 'border-warning bg-warning-soft' : 'border-accent bg-accent-soft'}`}><p className="m-0 font-medium text-ink0">{title}</p><div className="mt-1.5 text-ink1">{children}</div></div>;
}

function Choices({ rows }: { rows: Array<[string, string]> }) {
  return <div className="overflow-hidden rounded-lg border border-line0">{rows.map(([choice, consequence], index) => <div key={choice} className={`grid gap-1 px-4 py-3 md:grid-cols-[15rem_1fr] ${index ? 'border-t border-line0' : ''}`}><strong className="text-ink0">{choice}</strong><span>{consequence}</span></div>)}</div>;
}

export const HELP_TOPIC_BODIES: Record<string, ReactNode> = {
  comecar: <><p className="m-0">O Assistente Jurídico transforma documentos da Biblioteca em resumos ou revisões controladas. A aplicação faz a leitura; as fontes, decisões e aprovações continuam a ser suas.</p><Choices rows={[
    ['Preparar a Biblioteca', 'Confirme que os documentos estão prontos e trate primeiro das relações propostas.'],
    ['Criar um resumo', 'Escolha um documento e reveja obrigações, prazos e outras conclusões antes de gerar o Word.'],
    ['Rever um documento', 'Escolha o documento, confirme as fontes de comparação e decida as alterações jurídicas.'],
    ['Retomar trabalho', 'Em Análises, procure o documento principal e leia o Estado; abra o tipo de análise para continuar.'],
  ]} /><Callout title="A regra que protege todo o trabalho">Uma afirmação só entra no resultado quando aponta para um documento confirmado, uma página existente e um excerto encontrado nessa página. O que não cumpre esta regra fica excluído.</Callout></>,

  tutoriais: <><p className="m-0">Os tutoriais usam cópias internas e isoladas de exemplos da Biblioteca. Pode sair, continuar ou recomeçar quantas vezes quiser.</p><p className="m-0">Durante um tutorial, a orientação identifica o controlo ou a informação relevante. A Ajuda contextual abre sem abandonar o passo atual.</p><Callout title="Nada do tutorial altera a plataforma">As decisões de exemplo não criam análises, relações, versões ou ficheiros nos Resultados reais e nunca escrevem no OneDrive.</Callout></>,

  biblioteca: <><p className="m-0">A Biblioteca contém Documentos oficiais, Templates e Resultados. Só documentos oficiais prontos podem sustentar uma análise; os Templates definem o que será produzido; Resultados são os ficheiros produzidos por análises.</p><Choices rows={[
    ['Recebido / em leitura', 'Ainda não pode ser escolhido numa análise.'],
    ['Pronto', 'O texto e as páginas estão disponíveis para citações.'],
    ['Pronto com alerta', 'Pode ser usado, mas convém verificar as páginas que não ficaram bem transcritas.'],
    ['Erro', 'Abra o documento e use o controlo de reprocessamento existente.'],
  ]} /><p className="m-0">A pesquisa encontra nomes de ficheiros e pastas; não procura dentro do conteúdo.</p></>,

  'documento-resumo': <><p className="m-0">Esta área reúne a pré-visualização, identidade, estado de leitura e ações principais. Num Resultado, mostra também a análise que o produziu. Num Template, a ação principal abre o editor.</p><p className="m-0">Informação como hashes, versão do extrator e contagens estruturais serve para diagnóstico e fica em Detalhes técnicos.</p></>,

  'documento-metadados': <><p className="m-0">Os metadados descrevem o tipo, título, versão, datas, temas e referências legais. Corrija o que estiver errado: a correção humana prevalece sobre a classificação automática.</p><Callout title="Guardar não volta a ler o ficheiro">Alterar metadados não repete OCR, classificação nem embeddings. Os controlos de reprocessamento continuam separados e explícitos.</Callout></>,

  'documento-texto': <><p className="m-0">O texto está dividido por páginas porque cada citação precisa de apontar para uma página real. É uma ajuda para verificar o que a aplicação conseguiu ler, não um substituto da pré-visualização original.</p><p className="m-0">Num DOCX, a pré-visualização tenta mostrar primeiro uma versão PDF do documento original. Se isso não for possível, o texto aparece como alternativa e deve indicar o motivo.</p></>,

  'preparar-relacoes': <><p className="m-0">Uma relação diz que dois documentos devem ser considerados em conjunto. Tratar esta lista como preparação inicial melhora as recomendações de documentos de apoio no assistente de análise.</p><Choices rows={[
    ['Estado', 'É a sua decisão: por confirmar, confirmada ou rejeitada.'],
    ['Confiança', 'Indica a força da prova de que a ligação existe. Semelhança de texto, por si só, nunca confirma alteração ou substituição.'],
    ['Relevância', 'Estima quanto o segundo documento pode mudar as conclusões; não prova que a relação seja verdadeira.'],
    ['Confirmar', 'Passa a recomendar este documento quando o outro for escolhido numa análise.'],
    ['Rejeitar', 'O par deixa de ser usado como recomendação.'],
  ]} /><Callout title="Comece aqui quando prepara a aplicação">Se o separador Relações mostrar um número, existem decisões por tratar. Vale a pena resolvê-las antes de criar análises.</Callout></>,

  'documento-analises': <p className="m-0">Mostra análises onde o documento é principal ou foi confirmado como apoio. O número no separador conta as que ainda não terminaram e funciona como lista de trabalho.</p>,

  templates: <><p className="m-0">Cada fluxo usa um Template Word, um Template de e-mail e um Template de campos. A pré-visualização mostra o rascunho; só Guardar e publicar cria uma versão nova.</p><Choices rows={[
    ['Template Word (.docx)', 'Define a estrutura, o texto fixo e a apresentação do documento produzido.'],
    ['Template de e-mail (.eml)', 'Define o assunto e a mensagem que acompanham o PDF.'],
    ['Template de campos (.json)', 'Define a informação estruturada procurada e apresentada para revisão.'],
  ]} /><p className="m-0">Alterar um Template afeta análises futuras. Documentos e análises anteriores mantêm a versão com que foram produzidos. Os campos obrigatórios de citação não podem ser removidos.</p></>,

  'preparar-fontes': <><p className="m-0">Escolha um documento principal e confirme individualmente os documentos de apoio. O assistente recomenda primeiro relações que já confirmou na Biblioteca e explica a razão.</p><Callout title="Confirmar é dar autorização para citar">Um documento não confirmado não pode sustentar nenhuma afirmação. Excluir uma sugestão retira-a apenas desta análise.</Callout></>,

  'rever-resultados-resumo': <><p className="m-0">A aplicação apresenta obrigações, prazos, responsabilidades, sanções, referências e outros pontos encontrados. Comece pelo filtro “Requer atenção” e abra a fonte ao lado de cada conclusão.</p><p className="m-0">Aprovar os resultados autoriza a criação do Word apenas com os itens validados e não excluídos.</p></>,

  'rever-resultados-revisao': <><p className="m-0">Cada linha compara o documento principal com as fontes confirmadas. As linhas “Requer a sua decisão” precisam de Aceitar ou Rejeitar antes da aprovação conjunta.</p><p className="m-0">“Não aplicável” significa que aquela linha nunca exigiu decisão jurídica; não é trabalho pendente.</p></>,

  'resultado-excluido': <><p className="m-0">Um resultado é excluído automaticamente quando a fonte, página ou excerto não pode ser validado, ou por decisão sua. Ele permanece no registo para auditoria, mas não entra no documento.</p><Choices rows={[
    ['Corrigir conteúdo ou fonte', 'Cria uma nova extração e volta a validar a citação.'],
    ['Tentar novamente', 'Refaz apenas o trabalho permitido, sem transformar uma afirmação sem prova em válida.'],
    ['Manter excluído', 'Continua visível no registo e não entra no Word.'],
  ]} /></>,

  'refazer-resultados': <><p className="m-0">Use esta opção quando o conjunto está errado, não apenas um item. Indique o motivo para orientar a nova tentativa.</p><Callout title="Consequência" tone="warning">A extração atual fica preservada e identificada como rejeitada; nenhum documento é gerado a partir dela. Uma nova extração precisa de ser revista e aprovada de novo.</Callout></>,

  'voltar-fase': <><p className="m-0">Abra Histórico, selecione a etapa a retomar e escolha “Voltar aqui”. Escreva o que deve mudar e confirme a nova tentativa. A aplicação mostra apenas destinos válidos e descreve o que mantém, o que substitui e quais decisões terão de ser repetidas.</p><p className="m-0">O trabalho anterior não é apagado. A nova tentativa aparece como outra linha do Histórico, ligada ao ponto de regresso. Consulte cada percurso antes de usar “Passar a trabalhar nesta tentativa”.</p></>,

  'aprovar-word': <><p className="m-0">Depois de aprovar os resultados, reveja o Word completo. Pode pedir alterações ou editar uma nova versão. Aprovar escolhe este Word como documento final e permite gerar o PDF.</p><Callout title="Aprovar não apaga versões">Versões anteriores continuam em Versões e histórico. Se alterar o Word depois, o PDF anterior fica desatualizado.</Callout></>,

  'aprovar-pdf': <p className="m-0">Veja o PDF página a página. A aprovação confirma que corresponde ao Word final e que a paginação está correta. Só depois fica disponível o rascunho de e-mail.</p>,

  'preparar-email': <><p className="m-0">A aplicação prepara um rascunho com o PDF aprovado. Reveja e guarde os destinatários e o texto, aprove o e-mail e, depois, descarregue o ficheiro .eml numa ação separada para o abrir no Outlook.</p><Callout title="A aplicação nunca envia e-mail">Não existe permissão Mail.Send. O envio é sempre uma ação sua no programa de correio.</Callout></>,

  'detalhes-analise': <p className="m-0">Reúne tipo, instruções, fontes confirmadas, resultados estruturados e todos os ficheiros produzidos. O bloco Resultados distingue o rascunho atual, a versão Word aprovada, o PDF e o e-mail.</p>,

  'versoes-historico': <><p className="m-0">Abra Histórico para seguir a análise da esquerda para a direita. Selecione um cartão para consultar decisões e artefactos dessa etapa; use “Voltar aqui” apenas quando quer refazer o trabalho seguinte.</p><Choices rows={[["Consultar um percurso", "Mostra a conversa e os resultados dessa tentativa sem mudar o trabalho ativo."], ["Passar a trabalhar nesta tentativa", "Torna o percurso consultado ativo; novas decisões e versões ficam nele."], ["Voltar aqui", "Cria uma ramificação a partir da etapa selecionada e conserva o percurso anterior."]]} /><p className="m-0">O Registo técnico, no fim do painel, mantém datas, intervenientes e identificadores para auditoria.</p></>,

  resultados: <p className="m-0">Resultados reúne o Word, o PDF, o registo estruturado e o e-mail por análise. O estado pertence ao próprio ficheiro: aprovar o PDF não atribui aprovação ao registo JSON.</p>,

  problemas: <Choices rows={[
    ['Documento ainda não aparece', 'Confirme que é oficial e está pronto na Biblioteca.'],
    ['Relação recomendada em falta', 'Abra Relações nos dois documentos e confirme o par primeiro.'],
    ['Resultado excluído', 'Abra o motivo e corrija a fonte ou mantenha-o fora do documento.'],
    ['PDF desatualizado', 'Foi criado ou aprovado outro Word; gere um PDF correspondente à versão atual.'],
    ['Operação interrompida', 'Use a ação de retoma indicada pela própria fase; o histórico anterior permanece.'],
  ]} />,
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
