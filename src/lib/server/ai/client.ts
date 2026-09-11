import { getSetting } from '@/lib/server/db';
import { structuredCallInstructions } from '@/lib/server/ai/contract';
import { validateAgainstSchema, type JsonSchema } from '@/lib/server/ai/validate';
import { getValidCodexToken } from '@/lib/server/ai/vendor/codex-auth-runtime';
import { loadCodexToken } from '@/lib/server/ai/vendor/codex-token-store';
import {
  createResponse,
  type ModelProviderSettings,
  type ReasoningEffort,
} from '@/lib/server/ai/vendor/openai-responses';
import { genId } from '@/lib/server/crypto';
import { DEFAULT_AI_MODEL, isAiModel } from '@/lib/types';

// The one door every AI stage goes through: a bounded, synchronous, STRUCTURED call.
// No agent loop, no app tools, no web — the model receives exactly what the stage puts in
// `input`, and its only way to answer is the forced output tool whose parameters are the
// stage's JSON Schema. The result is validated app-side before anyone sees it, and a
// schema failure gets exactly one retry with the validation errors appended.

export const MODEL_SETTING_KEY = 'ai.model';

export type AiInputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'low' | 'high' | 'auto' };

export class AiNotConfiguredError extends Error {
  constructor() {
    super('AI is not configured. Connect ChatGPT (or set LEGAL_OPENAI_API_KEY) in Settings.');
  }
}

export class AiValidationError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(`Model output failed schema validation: ${errors.join('; ')}`);
    this.errors = errors;
  }
}

/**
 * Whether an AI call could currently succeed: a stored ChatGPT connection or an API key.
 * The app boots and runs without either — AI stages report `not_configured` instead of
 * failing, and the test suite runs entirely on that degradation path.
 */
export async function aiConfigured(): Promise<boolean> {
  if (String(process.env.LEGAL_OPENAI_API_KEY || '').trim()) return true;
  try {
    const token = await loadCodexToken();
    return Boolean(token?.access);
  } catch {
    return false;
  }
}

export function selectedModel(): string {
  const stored = String(getSetting(MODEL_SETTING_KEY) || '').trim();
  return isAiModel(stored) ? stored : DEFAULT_AI_MODEL;
}

async function resolveCall(): Promise<{ provider?: ModelProviderSettings; accessToken?: string; accountId?: string | null }> {
  // The ChatGPT subscription is the primary path; a platform API key is the
  // configuration-only fallback (used when no subscription is connected).
  const token = await loadCodexToken().catch(() => null);
  if (token?.access) {
    const valid = await getValidCodexToken();
    return { accessToken: String(valid.access), accountId: valid.accountId ?? null };
  }
  const apiKey = String(process.env.LEGAL_OPENAI_API_KEY || '').trim();
  if (apiKey) {
    return { provider: { id: 'openai-platform', label: 'OpenAI Platform', apiKey } };
  }
  throw new AiNotConfiguredError();
}

export async function aiStructured<T>(options: {
  task: string; // snake_case tool name, e.g. 'classify_document'
  instructions: string; // stage task description (the grounding contract is prepended)
  input: AiInputContent[];
  schema: JsonSchema;
  reasoningEffort?: ReasoningEffort;
  // Mechanical tasks (OCR transcription) skip the grounded-extraction contract — its
  // citation rules are about ANALYSIS output and would only add noise to a transcription.
  groundingContract?: boolean;
  signal?: AbortSignal;
}): Promise<T> {
  const call = await resolveCall();
  const model = selectedModel();
  const tool = {
    type: 'function',
    name: options.task,
    description: 'Deliver the structured result of this task. This is the only valid way to answer.',
    strict: true,
    parameters: options.schema as unknown as Record<string, unknown>,
  };

  const runOnce = async (extraUserText?: string): Promise<T> => {
    const content: Array<Record<string, unknown>> = options.input.map((part) => ({ ...part }));
    if (extraUserText) content.push({ type: 'input_text', text: extraUserText });
    const useContract = options.groundingContract !== false;
    const result = await createResponse({
      ...call,
      model,
      instructions: useContract
        ? structuredCallInstructions(options.instructions)
        : `${options.instructions}\n\nReturn your result ONLY by calling the provided output tool with a single argument object that satisfies its schema exactly.`,
      reasoning: { effort: options.reasoningEffort || 'medium' },
      input: [{ type: 'message', role: 'user', content }],
      tools: [tool],
      toolChoice: { type: 'function', name: options.task },
      sessionId: genId('call'),
      signal: options.signal,
    });

    const callItem = (result.output || []).find(
      (item) => item.type === 'function_call' && item.name === options.task && typeof item.arguments === 'string',
    );
    if (!callItem?.arguments) {
      throw new AiValidationError(['model did not call the output tool']);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(callItem.arguments);
    } catch {
      throw new AiValidationError(['output tool arguments were not valid JSON']);
    }
    const verdict = validateAgainstSchema(parsed, options.schema);
    if (!verdict.ok) throw new AiValidationError(verdict.errors);
    return parsed as T;
  };

  try {
    return await runOnce();
  } catch (error) {
    if (!(error instanceof AiValidationError)) throw error;
    // One retry, telling the model exactly what was wrong with its first attempt.
    return runOnce(
      `Your previous attempt was rejected by schema validation:\n${error.errors.map((e) => `- ${e}`).join('\n')}\nCall the output tool again with a corrected argument object.`,
    );
  }
}
