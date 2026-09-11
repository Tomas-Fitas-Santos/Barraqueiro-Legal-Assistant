// Vendored from natenai/agent src/lib/server/codex-auth-runtime.ts (2026-08-23), unchanged
// but for import paths: the whole refresh policy in three functions.
import { codexOauth } from '@/lib/server/ai/vendor/codex-oauth';
import { loadCodexToken, saveCodexToken, type CodexToken } from '@/lib/server/ai/vendor/codex-token-store';

export async function loadToken(): Promise<CodexToken | null> {
  return loadCodexToken();
}

export async function saveToken(token: Record<string, unknown>): Promise<void> {
  await saveCodexToken(token as CodexToken);
}

export async function getValidCodexToken(): Promise<CodexToken> {
  const token = await loadCodexToken();
  if (!token || !token.access) {
    throw new Error('Not authenticated with OpenAI ChatGPT Plus/Pro');
  }

  const expires = Number(token.expires || 0);
  if (expires > Date.now() + 60_000) {
    return token;
  }

  if (!token.refresh) {
    throw new Error('OpenAI session expired and no refresh token is available. Reauthorize.');
  }

  const refreshed = (await codexOauth().refresh(String(token.refresh))) as CodexToken;
  await saveCodexToken(refreshed);
  return refreshed;
}
