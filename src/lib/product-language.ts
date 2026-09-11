import type { AnalysisType } from '@/lib/types';
import type { PhaseKey } from '@/lib/workflow/phases';

/**
 * Words used to operate the product. Internal enums remain stable; this module is the
 * translation layer a legal user reads in the queue, current-task card, Help and tours.
 */
export const PRODUCT_AREAS = {
  analyses: 'Análises',
  library: 'Biblioteca',
  tutorials: 'Tutoriais',
  settings: 'Definições',
  help: 'Ajuda',
} as const;

export const WORK_BUCKET_LABELS = {
  waiting_user: 'Aguardam por si',
  working: 'A aplicação está a trabalhar',
  concluded: 'Concluídas',
} as const;

export type WorkBucket = keyof typeof WORK_BUCKET_LABELS;

export const ANALYSIS_JOURNEY_LABELS: Record<PhaseKey, string> = {
  configuracao: 'Preparar fontes',
  extracao: 'Encontrar resultados',
  revisao: 'Rever resultados',
  documento: 'Aprovar documento',
  pdf: 'Aprovar PDF',
  email: 'Preparar entrega',
};

export const ANALYSIS_RESULT_COPY: Record<AnalysisType, { noun: string; review: string }> = {
  summary: {
    noun: 'resultados encontrados',
    review: 'Rever as obrigações, prazos e restantes conclusões antes de criar o documento.',
  },
  revision: {
    noun: 'diferenças encontradas',
    review: 'Rever as diferenças e tomar as decisões jurídicas antes de criar o documento.',
  },
};

export const FINDING_STATUS_LABELS = {
  validated: 'Validado nos documentos',
  validation_rejected: 'Excluído por falta de suporte',
  legal_pending: 'Requer a sua decisão',
  user_accepted: 'Aceite por si',
  user_rejected: 'Excluído por si',
} as const;

export const VERSION_LANGUAGE = {
  section: 'Versões e histórico',
  main: 'Percurso principal',
  technicalLog: 'Registo técnico',
  current: 'Versão atual',
  approved: 'Versão aprovada',
  superseded: 'Versão anterior',
} as const;

export const TEMPLATE_LANGUAGE = {
  singular: 'Template',
  plural: 'Templates',
  word: 'Template Word',
  email: 'Template de e-mail',
  fields: 'Template de campos',
  standard: 'Template standard do fluxo',
} as const;

export const DELIVERY_LANGUAGE = {
  word: 'Documento Word',
  pdf: 'PDF para envio',
  email: 'Rascunho de e-mail',
} as const;
