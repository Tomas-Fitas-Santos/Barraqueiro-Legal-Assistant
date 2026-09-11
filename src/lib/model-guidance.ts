import { isAiModel, type AiModel } from "@/lib/types";

// What separates one model from another, FOR THIS APP.
//
// This is deliberately not fetched. OpenAI's catalogue was the obvious source and it turned
// out to describe all seventeen of its models with one sentence — "Our latest and most
// advanced model" — and to give every model this app offers the same context window. A
// refresh button cannot produce a comparison the vendor does not publish.
//
// So the comparison is the app's own, written against the app's own stages: how deep the
// reasoning goes, which work it suits, and what it costs against the subscription windows
// shown above it. It is labelled as guidance in the UI for exactly that reason — it is
// judgement about our pipeline, not a specification from OpenAI.

export type UsageLoad = "alto" | "medio" | "baixo";

export const USAGE_LOAD_LABELS: Record<UsageLoad, string> = {
  alto: "Alto",
  medio: "Médio",
  baixo: "Baixo",
};

/** Heavier reasoning drains the 5-hour and weekly windows faster — the pill colours say so. */
export const USAGE_LOAD_PILLS: Record<UsageLoad, string> = {
  alto: "ui-pill-warn",
  medio: "ui-pill-info",
  baixo: "ui-pill-ok",
};

export type ModelGuidance = {
  /** Depth against speed, in one line. */
  profile: string;
  /** The app work this model suits, named in the app's own vocabulary. */
  bestFor: string;
  load: UsageLoad;
};

export const MODEL_GUIDANCE: Record<AiModel, ModelGuidance> = {
  "gpt-5.6-sol": {
    profile: "Raciocínio profundo, resposta mais lenta.",
    bestFor:
      "Revisões e matrizes comparativas — o trabalho onde uma obrigação esquecida custa caro.",
    load: "alto",
  },
  "gpt-5.6-terra": {
    profile: "Equilíbrio entre profundidade e rapidez.",
    bestFor:
      "O trabalho corrente: resumos documentais e revisões do dia a dia.",
    load: "medio",
  },
  "gpt-5.6-luna": {
    profile: "Rápido, com raciocínio mais curto.",
    bestFor:
      "Tratar muitos documentos de uma vez — leitura e classificação de uma biblioteca inteira.",
    load: "baixo",
  },
  "gpt-5.5": {
    profile: "Geração anterior, também de raciocínio profundo.",
    bestFor:
      "Alternativa estável, se notar que a geração 5.6 piorou algum resultado.",
    load: "alto",
  },
  "gpt-5.4": {
    profile: "Geração mais antiga.",
    bestFor: "Comparar com análises feitas no passado neste mesmo modelo.",
    load: "medio",
  },
  "gpt-5.4-mini": {
    profile: "Antigo e leve.",
    bestFor: "Ensaios rápidos sem gastar a janela de utilização.",
    load: "baixo",
  },
  "gpt-5.3-codex-spark": {
    profile: "O mais leve e rápido da lista.",
    bestFor:
      "Apenas tarefas mecânicas. Não é aconselhado para análises jurídicas.",
    load: "baixo",
  },
};

export function modelGuidance(id: string): ModelGuidance | null {
  return isAiModel(id) ? MODEL_GUIDANCE[id] : null;
}
