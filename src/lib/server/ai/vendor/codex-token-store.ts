// Same interface as natenai/agent src/lib/server/codex-token-store.ts, but the storage is
// rewritten at its seam: the token lives in our settings table, sealed by secrets.ts
// (AES-256-GCM at rest) — strictly better than the origin's plaintext-JSON-file scheme.
// Signatures stay async to match the origin so codex-auth-runtime carries over unchanged.
import { getSecretSetting, setSecretSetting } from '@/lib/server/secrets';

export type CodexToken = {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  accountId?: string | null;
  email?: string | null;
  displayName?: string | null;
};

const TOKEN_SETTING_KEY = 'ai.codex_token';

export async function saveCodexToken(token: CodexToken): Promise<void> {
  setSecretSetting(TOKEN_SETTING_KEY, JSON.stringify(token));
}

export async function loadCodexToken(): Promise<CodexToken | null> {
  const raw = getSecretSetting(TOKEN_SETTING_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CodexToken;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function clearCodexToken(): Promise<void> {
  setSecretSetting(TOKEN_SETTING_KEY, '');
}
