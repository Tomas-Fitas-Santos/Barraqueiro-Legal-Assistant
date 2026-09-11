// Vendored from natenai/agent src/lib/server/openai-responses.ts (2026-08-23) — the
// Responses-API client for the ChatGPT-subscription (Codex) endpoint, SSE parsing and all.
// Adapted for this repo: local Reasoning/provider types (the origin's 278-line provider
// registry is replaced by one inline URL helper), our originator header, and one addition —
// `toolChoice` is forwarded as `tool_choice` so a structured call can force its output tool.
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

const ORIGINATOR = 'legal-assistant';

export const REASONING_EFFORT_VALUES = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

export type ReasoningConfig = {
  effort: ReasoningEffort;
  summary?: 'none' | 'auto' | 'concise' | 'detailed';
};

// Two providers only: the subscription (default) and a plain API key as the
// configuration-only fallback. Nothing else is wired on purpose.
export type ModelProviderSettings = {
  id: 'chatgpt-codex' | 'openai-platform';
  label: string;
  baseUrl?: string;
  apiKey?: string;
};

function providerResponsesUrl(provider: ModelProviderSettings): string {
  const base = String(provider.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  return `${base}/responses`;
}

type ResponseOutputItem = {
  id?: string;
  type?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  role?: string;
  phase?: 'commentary' | 'final_answer';
  content?: Array<{ type?: string; text?: string }>;
  summary?: Array<Record<string, unknown>>;
};

export type ResponsesApiResult = {
  id?: string;
  output?: ResponseOutputItem[];
  created_at?: number;
  model?: string;
  incomplete_details?: Record<string, unknown> | null;
  usage?: Record<string, unknown>;
  service_tier?: string | null;
};

type StreamEvent = Record<string, unknown>;

export type ResponseOutputTextDelta = {
  itemId: string;
  outputIndex: number;
  contentIndex?: number;
  sequenceNumber?: number;
  delta: string;
  text: string;
  phase?: 'commentary' | 'final_answer';
};

export type ResponseReasoningDelta = {
  itemId: string;
  outputIndex: number;
  summaryIndex?: number;
  contentIndex?: number;
  sequenceNumber?: number;
  delta: string;
  text: string;
};

function sanitizeMessageContentParts(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part): Array<Record<string, unknown>> => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const record = part as Record<string, unknown>;
    if ((record.type === 'input_text' || record.type === 'output_text') && typeof record.text === 'string') {
      return [{ type: record.type, text: record.text }];
    }
    if (record.type === 'input_image' && typeof record.image_url === 'string') {
      const detail = record.detail;
      return [{
        type: 'input_image',
        image_url: record.image_url,
        ...(detail === 'low' || detail === 'high' || detail === 'auto' || detail === 'original' ? { detail } : {}),
      }];
    }
    return [];
  });
}

function sanitizeFunctionCallOutput(output: unknown): string | Array<Record<string, unknown>> {
  if (!Array.isArray(output)) return typeof output === 'string' ? output : JSON.stringify(output ?? '');
  return output.flatMap((part): Array<Record<string, unknown>> => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const record = part as Record<string, unknown>;
    if (record.type === 'input_text' && typeof record.text === 'string') {
      return [{ type: 'input_text', text: record.text }];
    }
    if (record.type === 'input_image' && typeof record.image_url === 'string') {
      const detail = record.detail;
      return [{
        type: 'input_image',
        image_url: record.image_url,
        ...(detail === 'low' || detail === 'high' || detail === 'auto' || detail === 'original' ? { detail } : {}),
      }];
    }
    return [];
  });
}

export function sanitizeResponsesInputItem(item: Record<string, unknown>): Record<string, unknown> | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (item.type === 'message' && (item.role === 'user' || item.role === 'assistant')) {
    const phase = item.phase === 'commentary' || item.phase === 'final_answer' ? item.phase : undefined;
    return {
      type: 'message',
      role: item.role,
      ...(phase ? { phase } : {}),
      content: sanitizeMessageContentParts(item.content),
    };
  }
  if (item.type === 'function_call') {
    const name = typeof item.name === 'string' ? item.name : '';
    const callId = typeof item.call_id === 'string' ? item.call_id : '';
    if (!name || !callId) return null;
    return {
      type: 'function_call',
      name,
      call_id: callId,
      arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
    };
  }
  if (item.type === 'function_call_output') {
    const callId = typeof item.call_id === 'string' ? item.call_id : '';
    if (!callId) return null;
    return {
      type: 'function_call_output',
      call_id: callId,
      output: sanitizeFunctionCallOutput(item.output),
    };
  }
  return null;
}

export function sanitizeResponsesInput(input: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return input.flatMap((item) => {
    const sanitized = sanitizeResponsesInputItem(item);
    return sanitized ? [sanitized] : [];
  });
}

function ensureOutputItem(output: ResponseOutputItem[], index: number, fallback: ResponseOutputItem): ResponseOutputItem {
  const existing = output[index];
  if (existing) return existing;
  output[index] = fallback;
  return output[index]!;
}

function ensureReasoningOutputItem(output: ResponseOutputItem[], outputIndex: number, itemId: string): { item: ResponseOutputItem; index: number } {
  const safeOutputIndex = Number.isInteger(outputIndex) && outputIndex >= 0 ? outputIndex : output.length;
  const existing = output[safeOutputIndex];
  if (existing && existing.type === 'reasoning') {
    return { item: existing, index: safeOutputIndex };
  }
  if (!existing) {
    output[safeOutputIndex] = {
      id: itemId,
      type: 'reasoning',
      summary: [],
    };
    return { item: output[safeOutputIndex]!, index: safeOutputIndex };
  }
  output.push({
    id: itemId,
    type: 'reasoning',
    summary: [],
  });
  return { item: output[output.length - 1]!, index: output.length - 1 };
}

function mergeMessageText(
  outputItems: ResponseOutputItem[],
  messageTextByItemId: Map<string, string>,
): ResponseOutputItem[] {
  return outputItems.map((entry) => {
    if (!entry || typeof entry !== 'object' || entry.type !== 'message' || !entry.id) return entry;

    const streamedText = messageTextByItemId.get(entry.id) || '';
    const existingText = Array.isArray(entry.content)
      ? entry.content
          .filter((part) => part && typeof part === 'object' && part.type === 'output_text')
          .map((part) => String(part.text || ''))
          .join('')
      : '';

    const text = streamedText || existingText;
    return {
      ...entry,
      role: entry.role || 'assistant',
      phase: entry.phase === 'commentary' || entry.phase === 'final_answer' ? entry.phase : undefined,
      content: text ? [{ type: 'output_text', text }] : Array.isArray(entry.content) ? entry.content : [],
    };
  });
}

function mergeReasoningText(
  outputItems: ResponseOutputItem[],
  reasoningTextByKey: Map<string, string>,
): ResponseOutputItem[] {
  return outputItems.map((entry) => {
    if (!entry || typeof entry !== 'object' || entry.type !== 'reasoning' || !entry.id) return entry;
    const streamedSummary = reasoningTextByKey.get(`${entry.id}:summary:0:`) || '';
    return {
      ...entry,
      summary: Array.isArray(entry.summary) && entry.summary.length > 0
        ? entry.summary
        : streamedSummary
          ? [{ type: 'summary_text', text: streamedSummary }]
          : entry.summary,
    };
  });
}

function normalizeSummary(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const summary = value
    .flatMap((entry): Array<Record<string, unknown>> => {
      if (typeof entry === 'string') {
        const text = entry.trim();
        return text ? [{ type: 'summary_text', text }] : [];
      }
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) return [entry as Record<string, unknown>];
      return [];
    });
  return summary.length > 0 ? summary : [];
}

function mergeOutputItems(baseItems: ResponseOutputItem[], streamedItems: ResponseOutputItem[]): ResponseOutputItem[] {
  const maxLength = Math.max(baseItems.length, streamedItems.length);
  const merged: ResponseOutputItem[] = [];
  for (let index = 0; index < maxLength; index += 1) {
    const base = baseItems[index];
    const streamed = streamedItems[index];
    if (!base && !streamed) continue;
    merged.push({
      ...(base || {}),
      ...(streamed || {}),
      phase: base?.phase || streamed?.phase,
      content: Array.isArray(base?.content) && base.content.length > 0 ? base.content : streamed?.content,
      summary: Array.isArray(base?.summary) ? base.summary : streamed?.summary,
    });
  }
  return merged;
}

function reasoningPayloadForRequest(reasoning: ReasoningConfig): Record<string, unknown> {
  return {
    effort: reasoning.effort,
    ...(reasoning.summary && reasoning.summary !== 'none' ? { summary: reasoning.summary } : {}),
  };
}

export async function createResponse(payload: {
  provider?: ModelProviderSettings;
  model: string;
  instructions: string;
  reasoning?: ReasoningConfig;
  input: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  toolChoice?: Record<string, unknown>;
  sessionId: string;
  accessToken?: string;
  accountId?: string | null;
  signal?: AbortSignal;
  onOutputTextDelta?: (event: ResponseOutputTextDelta) => void | Promise<void>;
  onReasoningDelta?: (event: ResponseReasoningDelta) => void | Promise<void>;
}): Promise<ResponsesApiResult> {
  const provider = payload.provider;
  const isCodex = !provider || provider.id === 'chatgpt-codex';
  const url = isCodex ? CODEX_RESPONSES_URL : providerResponsesUrl(provider);
  const apiKey = String(isCodex ? payload.accessToken || '' : provider?.apiKey || '').trim();
  if (!apiKey) {
    throw new Error(`${provider?.label || 'Responses provider'} is not connected.`);
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(isCodex
        ? {
            originator: ORIGINATOR,
            'User-Agent': `${ORIGINATOR}/0.1`,
            session_id: payload.sessionId,
            ...(payload.accountId ? { 'ChatGPT-Account-Id': payload.accountId } : {}),
          }
        : {}),
    },
    signal: payload.signal,
    body: JSON.stringify({
      model: payload.model,
      instructions: payload.instructions,
      ...(payload.reasoning ? { reasoning: reasoningPayloadForRequest(payload.reasoning) } : {}),
      input: sanitizeResponsesInput(payload.input),
      tools: payload.tools,
      ...(payload.toolChoice ? { tool_choice: payload.toolChoice } : {}),
      store: false,
      stream: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${provider?.label || 'Responses'} API error ${res.status}: ${text.slice(0, 500)}`);
  }
  let lastJson: Record<string, unknown> | null = null;
  let responseId = '';
  let createdAt = 0;
  let model = '';
  let incompleteDetails: Record<string, unknown> | null = null;
  let usage: Record<string, unknown> | undefined;
  let serviceTier: string | null = null;
  const output: ResponseOutputItem[] = [];
  const messageTextByItemId = new Map<string, string>();
  const reasoningTextByKey = new Map<string, string>();
  const outputIndexByItemId = new Map<string, number>();
  const phaseByItemId = new Map<string, 'commentary' | 'final_answer'>();

  const handleStreamData = async (chunk: string): Promise<boolean> => {
    if (!chunk || chunk === '[DONE]') return chunk === '[DONE]';
    try {
      const item = JSON.parse(chunk) as StreamEvent;
      const type = String(item.type || '').trim();

      if (type === 'error') {
        const code = String(item.code || '').trim();
        const rawEvent = (() => {
          try {
            return JSON.stringify(item).slice(0, 500);
          } catch {
            return '';
          }
        })();
        const message = String(item.message || '').trim() || `Codex streaming error event without message${rawEvent ? `: ${rawEvent}` : ''}`;
        throw new Error(code ? `${code}: ${message}` : message);
      }

      if (type === 'response.created' && item.response && typeof item.response === 'object') {
        const response = item.response as Record<string, unknown>;
        responseId = String(response.id || '').trim() || responseId;
        createdAt = Number(response.created_at || 0) || createdAt;
        model = String(response.model || '').trim() || model;
        serviceTier = typeof response.service_tier === 'string' ? response.service_tier : serviceTier;
      }

      if ((type === 'response.completed' || type === 'response.incomplete') && item.response && typeof item.response === 'object') {
        const response = item.response as Record<string, unknown>;
        incompleteDetails =
          response.incomplete_details && typeof response.incomplete_details === 'object'
            ? (response.incomplete_details as Record<string, unknown>)
            : incompleteDetails;
        usage = response.usage && typeof response.usage === 'object' ? (response.usage as Record<string, unknown>) : usage;
        serviceTier = typeof response.service_tier === 'string' ? response.service_tier : serviceTier;
      }

      if ((type === 'response.output_item.added' || type === 'response.output_item.done') && item.item && typeof item.item === 'object') {
        const outputIndex = Number(item.output_index);
        if (Number.isInteger(outputIndex) && outputIndex >= 0) {
          const responseItem = item.item as Record<string, unknown>;
          const parsed: ResponseOutputItem = {
            id: typeof responseItem.id === 'string' ? responseItem.id : undefined,
            type: typeof responseItem.type === 'string' ? responseItem.type : undefined,
            name: typeof responseItem.name === 'string' ? responseItem.name : undefined,
            call_id: typeof responseItem.call_id === 'string' ? responseItem.call_id : undefined,
            arguments: typeof responseItem.arguments === 'string' ? responseItem.arguments : undefined,
            summary: normalizeSummary(responseItem.summary),
            phase:
              responseItem.phase === 'commentary' || responseItem.phase === 'final_answer'
                ? responseItem.phase
                : undefined,
          };
          output[outputIndex] = {
            ...ensureOutputItem(output, outputIndex, {}),
            ...parsed,
          };
          if (parsed.id) {
            outputIndexByItemId.set(parsed.id, outputIndex);
            if (parsed.phase) phaseByItemId.set(parsed.id, parsed.phase);
          }
        }
      }

      if (type === 'response.output_text.delta') {
        const itemId = String(item.item_id || '').trim();
        const explicitOutputIndex = Number(item.output_index);
        const outputIndex = Number.isInteger(explicitOutputIndex) && explicitOutputIndex >= 0
          ? explicitOutputIndex
          : outputIndexByItemId.get(itemId) ?? 0;
        const contentIndex = Number(item.content_index);
        const sequenceNumber = Number(item.sequence_number);
        const delta = String(item.delta || '');
        if (itemId) {
          const text = `${messageTextByItemId.get(itemId) || ''}${delta}`;
          messageTextByItemId.set(itemId, text);
          if (delta && payload.onOutputTextDelta) {
            await payload.onOutputTextDelta({
              itemId,
              outputIndex,
              ...(Number.isInteger(contentIndex) && contentIndex >= 0 ? { contentIndex } : {}),
              ...(Number.isInteger(sequenceNumber) && sequenceNumber >= 0 ? { sequenceNumber } : {}),
              delta,
              text,
              phase: phaseByItemId.get(itemId),
            });
          }
        }
      }

      if (type === 'response.reasoning_summary_text.delta') {
        const itemId = String(item.item_id || '').trim();
        const explicitOutputIndex = Number(item.output_index);
        const outputIndex = Number.isInteger(explicitOutputIndex) && explicitOutputIndex >= 0
          ? explicitOutputIndex
          : outputIndexByItemId.get(itemId) ?? output.length;
        const summaryIndex = Number(item.summary_index);
        const sequenceNumber = Number(item.sequence_number);
        const delta = String(item.delta || '');
        const key = [
          itemId,
          Number.isInteger(summaryIndex) && summaryIndex >= 0 ? `summary:${summaryIndex}` : '',
          '',
        ].join(':');
        if (itemId) {
          const reasoningItem = ensureReasoningOutputItem(output, outputIndex, itemId);
          outputIndexByItemId.set(itemId, reasoningItem.index);
          const text = `${reasoningTextByKey.get(key) || ''}${delta}`;
          reasoningTextByKey.set(key, text);
          if (delta && payload.onReasoningDelta) {
            await payload.onReasoningDelta({
              itemId,
              outputIndex,
              ...(Number.isInteger(summaryIndex) && summaryIndex >= 0 ? { summaryIndex } : {}),
              ...(Number.isInteger(sequenceNumber) && sequenceNumber >= 0 ? { sequenceNumber } : {}),
              delta,
              text,
            });
          }
        }
      }

      if (type === 'response.reasoning.delta') {
        const itemId = String(item.item_id || '').trim() || 'reasoning';
        const explicitOutputIndex = Number(item.output_index);
        const outputIndex = Number.isInteger(explicitOutputIndex) && explicitOutputIndex >= 0
          ? explicitOutputIndex
          : outputIndexByItemId.get(itemId) ?? output.length;
        const contentIndex = Number(item.content_index);
        const sequenceNumber = Number(item.sequence_number);
        const delta = String(item.delta || '');
        const reasoningItem = ensureReasoningOutputItem(output, outputIndex, itemId);
        outputIndexByItemId.set(itemId, reasoningItem.index);
        const key = [itemId, 'summary:0', ''].join(':');
        const text = `${reasoningTextByKey.get(key) || ''}${delta}`;
        reasoningTextByKey.set(key, text);
        if (delta && payload.onReasoningDelta) {
          await payload.onReasoningDelta({
            itemId,
            outputIndex,
            ...(Number.isInteger(contentIndex) && contentIndex >= 0 ? { contentIndex } : {}),
            ...(Number.isInteger(sequenceNumber) && sequenceNumber >= 0 ? { sequenceNumber } : {}),
            delta,
            text,
          });
        }
      }

      if (item.response && typeof item.response === 'object') {
        lastJson = item.response as Record<string, unknown>;
      } else {
        lastJson = item;
      }
    } catch (error) {
      if (error instanceof Error) throw error;
      // ignore invalid event chunks
    }
    return false;
  };

  if (!res.body) {
    const text = await res.text();
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      if (await handleStreamData(line.slice(5).trim())) break;
    }
  } else {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamDone = false;
    while (!streamDone) {
      const read = await reader.read();
      streamDone = read.done;
      buffer += decoder.decode(read.value, { stream: !read.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        if (await handleStreamData(line.slice(5).trim())) {
          streamDone = true;
          break;
        }
      }
    }
    const line = buffer.trim();
    if (line.startsWith('data:')) {
      await handleStreamData(line.slice(5).trim());
    }
  }
  if (!lastJson) {
    throw new Error('Codex stream ended without a JSON response payload');
  }
  const completedJson = lastJson as unknown as ResponsesApiResult & Record<string, unknown>;

  const finalOutput = mergeReasoningText(
    mergeMessageText(
      mergeOutputItems(
        (Array.isArray(completedJson.output) ? (completedJson.output as ResponseOutputItem[]) : []).filter(Boolean) as ResponseOutputItem[],
        output.filter(Boolean) as ResponseOutputItem[],
      ),
      messageTextByItemId,
    ),
    reasoningTextByKey,
  );

  return {
    ...completedJson,
    ...(responseId ? { id: responseId } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(model ? { model } : {}),
    ...(incompleteDetails ? { incomplete_details: incompleteDetails } : {}),
    ...(usage ? { usage } : {}),
    ...(serviceTier !== null ? { service_tier: serviceTier } : {}),
    ...(finalOutput.length > 0 ? { output: finalOutput } : {}),
  };
}
