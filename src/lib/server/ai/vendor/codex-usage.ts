// Vendored from natenai/agent src/lib/server/codex-usage.ts (2026-08-23) — the ChatGPT
// plan rate-limit windows shown on the Settings page. Import paths + User-Agent adapted.
import { getValidCodexToken } from '@/lib/server/ai/vendor/codex-auth-runtime';

export type CodexUsageWindow = {
  usedPercent: number;
  remainingPercent: number;
  resetAt: number;
  limitWindowSeconds: number;
};

export type CodexPlanUsage = {
  planType?: string;
  accountId?: string | null;
  email?: string | null;
  displayName?: string | null;
  primaryWindow?: CodexUsageWindow;
  secondaryWindow?: CodexUsageWindow;
  credits?: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: number | null;
  };
};

type RawCodexUsageWindow = {
  used_percent?: unknown;
  reset_at?: unknown;
  limit_window_seconds?: unknown;
};

type RawCodexUsageResponse = {
  plan_type?: unknown;
  rate_limit?: {
    primary_window?: RawCodexUsageWindow | null;
    secondary_window?: RawCodexUsageWindow | null;
  } | null;
  credits?: {
    has_credits?: unknown;
    unlimited?: unknown;
    balance?: unknown;
  } | null;
};

function numberOrNull(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(number) ? number : null;
}

function normalizeWindow(value: RawCodexUsageWindow | null | undefined): CodexUsageWindow | undefined {
  if (!value) return undefined;
  const usedPercent = numberOrNull(value.used_percent);
  const resetAt = numberOrNull(value.reset_at);
  const limitWindowSeconds = numberOrNull(value.limit_window_seconds);
  if (usedPercent === null || resetAt === null || limitWindowSeconds === null) return undefined;
  const clampedUsed = Math.max(0, Math.min(100, usedPercent));
  return {
    usedPercent: clampedUsed,
    remainingPercent: Math.max(0, Math.min(100, 100 - clampedUsed)),
    resetAt,
    limitWindowSeconds,
  };
}

export async function getCodexPlanUsage(): Promise<CodexPlanUsage> {
  const token = await getValidCodexToken();
  const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
    method: 'GET',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token.access}`,
      'User-Agent': 'LegalAssistant',
      ...(token.accountId ? { 'ChatGPT-Account-Id': token.accountId } : {}),
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error('ChatGPT usage request was rejected. Reauthorize the ChatGPT account.');
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ChatGPT usage request failed with HTTP ${response.status}${body ? `: ${body}` : ''}`);
  }

  const body = (await response.json()) as RawCodexUsageResponse;
  const balance = numberOrNull(body.credits?.balance);

  return {
    planType: typeof body.plan_type === 'string' ? body.plan_type : undefined,
    accountId: token.accountId,
    email: token.email,
    displayName: token.displayName,
    primaryWindow: normalizeWindow(body.rate_limit?.primary_window),
    secondaryWindow: normalizeWindow(body.rate_limit?.secondary_window),
    credits: body.credits
      ? {
          hasCredits: body.credits.has_credits === true,
          unlimited: body.credits.unlimited === true,
          balance,
        }
      : undefined,
  };
}
