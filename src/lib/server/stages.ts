// Workflow stages and their deterministic track-back prompts (LEAF module — no imports —
// so the unit suite exercises exactly what ships).
//
// Tracking back to a stage always asks the SAME question for that stage: the user answers,
// the analysis branches to a new path (a → b), and the work restarts from there carrying
// the answer as guidance. The prompts are fixed text, never model-generated, so the user
// learns them and the behaviour is reproducible.

export const STAGE_KEYS = ['configuracao', 'extracao', 'revisao', 'documento', 'pdf', 'email'] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

export type StageDef = {
  key: StageKey;
  label: string;
  /** Stages that only exist for one workflow type. */
  onlyFor?: 'summary' | 'revision';
  /** What the agent asks when the user tracks back here. */
  prompt: string;
  placeholder: string;
  /** What re-running from this stage does. */
  restart: 'run' | 'relations' | 'generate' | 'review_only';
};

export const STAGES: StageDef[] = [
  {
    key: 'configuracao',
    label: 'Configuração',
    prompt:
      'Vamos recomeçar a partir da configuração. O que deve mudar no âmbito da análise? Indique, por exemplo, documentos relacionados a incluir ou excluir, o foco pretendido, ou restrições a respeitar.',
    placeholder: 'Ex.: incluir também o Regulamento do Canal de Denúncia; focar nas obrigações de reporte.',
    restart: 'relations',
  },
  {
    key: 'extracao',
    label: 'Extração',
    onlyFor: 'summary',
    prompt:
      'Vamos repetir a extração. Que tipos de conteúdo devem ser privilegiados ou tratados de forma diferente? Indique, por exemplo, obrigações a não perder, secções a ignorar, ou o nível de detalhe desejado.',
    placeholder: 'Ex.: extrair também as definições; ignorar os anexos; mais detalhe nos prazos.',
    restart: 'run',
  },
  {
    key: 'extracao',
    label: 'Matriz comparativa',
    onlyFor: 'revision',
    prompt:
      'Vamos reconstruir a matriz comparativa. Que critérios de comparação devem mudar? Indique, por exemplo, tópicos a cobrir obrigatoriamente, o tipo de propostas de alteração pretendido, ou pontos a ignorar.',
    placeholder: 'Ex.: comparar apenas âmbito e sanções; propor alterações conservadoras.',
    restart: 'run',
  },
  {
    key: 'revisao',
    label: 'Revisão',
    prompt:
      'Vamos rever de novo os itens validados. Que decisões devem ser reconsideradas e com que critério? Indique o que aceitar, rejeitar ou tratar com mais cuidado.',
    placeholder: 'Ex.: rejeitar sugestões da IA; aceitar apenas itens com fonte direta.',
    restart: 'review_only',
  },
  {
    key: 'documento',
    label: 'Documento',
    prompt:
      'Vamos gerar o documento de outra forma. Como deve ficar? Indique estrutura, tom, extensão ou secções a incluir/excluir.',
    placeholder: 'Ex.: mais conciso, com uma secção final de recomendações; tom formal.',
    restart: 'generate',
  },
  {
    key: 'pdf',
    label: 'PDF final',
    prompt:
      'Vamos preparar de novo a versão final e o PDF. O que deve ser corrigido antes de fixar a versão final?',
    placeholder: 'Ex.: corrigir o título; retirar a secção 4 antes de fixar como final.',
    restart: 'generate',
  },
  {
    key: 'email',
    label: 'E-mail',
    prompt:
      'Vamos preparar de novo o envio. O que deve mudar no documento antes de gerar o rascunho de e-mail?',
    placeholder: 'Ex.: acrescentar nota introdutória; rever o anexo de fontes.',
    restart: 'generate',
  },
];

export function stagesFor(type: 'summary' | 'revision'): StageDef[] {
  return STAGES.filter((stage) => !stage.onlyFor || stage.onlyFor === type);
}

export function stageFor(type: 'summary' | 'revision', key: string): StageDef | null {
  return stagesFor(type).find((stage) => stage.key === key) || null;
}
