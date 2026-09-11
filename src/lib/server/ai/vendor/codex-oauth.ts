// Vendored from natenai/agent src/lib/server/codex-oauth.ts (2026-08-23) — the proven
// ChatGPT Plus/Pro (Codex) subscription OAuth clone. Adapted for this repo: our data dir,
// our originator string, base URL from LEGAL_PUBLIC_BASE_URL. Keep diffs against the
// origin minimal so upstream fixes stay easy to carry over.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';

import { LEGAL_DATA_DIR } from '@/lib/server/paths';

const ISSUER = 'https://auth.openai.com';
// The public Codex CLI client id — subscription OAuth is only issued against it.
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = `${ISSUER}/oauth/token`;
const DEVICE_USERCODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${ISSUER}/api/accounts/deviceauth/token`;
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000;
const OAUTH_PORT = 1455;
const LOCAL_OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_PORT}/auth/callback`;
const HOST_OAUTH_CALLBACK_PATH = '/api/auth/openai/callback';

export const OAUTH_ORIGINATOR = 'legal-assistant';
const PUBLIC_BASE_URL = String(process.env.LEGAL_PUBLIC_BASE_URL || '').trim();

type PendingAuth = {
  state: string;
  verifier: string;
  redirectUri: string;
};

type PendingDeviceAuth = {
  device_auth_id: string;
  user_code: string;
  interval_ms: number;
  created_at: number;
};

type BrowserResult =
  | { status: 'pending' }
  | { status: 'authorized'; token: Record<string, unknown> }
  | { status: 'error'; error: string };

type PersistedPendingAuth = {
  createdAt: number;
  verifier?: string;
  redirectUri?: string;
};

type PersistedAuthState = {
  pending: Record<string, PersistedPendingAuth>;
  results: Record<string, { status: 'authorized'; token: Record<string, unknown> } | { status: 'error'; error: string }>;
};

type PersistedDeviceAuthState = {
  pending: Record<string, PendingDeviceAuth>;
};

// In-flight OAuth state files (NOT the token itself — that goes encrypted into settings via
// codex-token-store). Kept on disk so a flow survives a server restart mid-login.
const SETTINGS_DIR = path.join(LEGAL_DATA_DIR, 'oauth-state');
const OAUTH_STATE_PATH = path.join(SETTINGS_DIR, 'openai_oauth_states.json');
const DEVICE_OAUTH_STATE_PATH = path.join(SETTINGS_DIR, 'openai_device_oauth_states.json');

function tokenUrlSafe(bytes: number): string {
  return randomBytes(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function firstForwardedHeader(value: string | null): string {
  return String(value || '').split(',')[0]?.trim() || '';
}

function normalizeBaseUrl(value: string | null | undefined): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0.0.0.0' ||
    normalized.startsWith('127.')
  );
}

function isLoopbackBaseUrl(value: string): boolean {
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function resolveRequestBaseUrl(request: Request): string {
  const requestUrl = new URL(request.url);
  const forwardedHost = firstForwardedHeader(request.headers.get('x-forwarded-host'));
  const host = forwardedHost || firstForwardedHeader(request.headers.get('host'));
  if (!host) return requestUrl.origin;

  const forwardedProto = firstForwardedHeader(request.headers.get('x-forwarded-proto'));
  const protocol = forwardedProto || (forwardedHost ? 'https' : requestUrl.protocol.replace(/:$/, '') || 'http');
  return normalizeBaseUrl(`${protocol}://${host}`) || requestUrl.origin;
}

export function resolveOpenAICallbackBaseUrl(request: Request): string {
  const configuredBaseUrl = normalizeBaseUrl(PUBLIC_BASE_URL);
  const requestBaseUrl = normalizeBaseUrl(resolveRequestBaseUrl(request));

  if (!configuredBaseUrl) return requestBaseUrl;
  if (!requestBaseUrl) return configuredBaseUrl;

  if (isLoopbackBaseUrl(configuredBaseUrl) && !isLoopbackBaseUrl(requestBaseUrl)) {
    return requestBaseUrl;
  }

  return configuredBaseUrl;
}

function decodeClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = `${parts[1]}${'='.repeat((4 - (parts[1].length % 4)) % 4)}`;
    const data = Buffer.from(payload, 'base64url').toString('utf-8');
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

class CodexOAuth {
  private pending = new Map<string, PendingAuth>();
  private pendingDevice = new Map<string, PendingDeviceAuth>();
  private browserResults = new Map<string, BrowserResult>();
  private oauthServer: HttpServer | null = null;
  private oauthServerStarting = false;

  private loadPersistedState(): PersistedAuthState {
    try {
      const raw = readFileSync(OAUTH_STATE_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PersistedAuthState>;
      return {
        pending: parsed.pending && typeof parsed.pending === 'object' ? parsed.pending : {},
        results: parsed.results && typeof parsed.results === 'object' ? parsed.results : {},
      };
    } catch {
      return { pending: {}, results: {} };
    }
  }

  private savePersistedState(state: PersistedAuthState): void {
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(OAUTH_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
  }

  private loadPersistedDeviceState(): PersistedDeviceAuthState {
    try {
      const raw = readFileSync(DEVICE_OAUTH_STATE_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PersistedDeviceAuthState>;
      return {
        pending: parsed.pending && typeof parsed.pending === 'object' ? (parsed.pending as Record<string, PendingDeviceAuth>) : {},
      };
    } catch {
      return { pending: {} };
    }
  }

  private savePersistedDeviceState(state: PersistedDeviceAuthState): void {
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(DEVICE_OAUTH_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
  }

  private setPendingDevice(pollId: string, pending: PendingDeviceAuth): void {
    this.pendingDevice.set(pollId, pending);
    const persisted = this.loadPersistedDeviceState();
    persisted.pending[pollId] = pending;
    this.savePersistedDeviceState(persisted);
  }

  private getPendingDevice(pollId: string): PendingDeviceAuth | null {
    const cached = this.pendingDevice.get(pollId);
    if (cached) return cached;
    const persisted = this.loadPersistedDeviceState();
    const pending = persisted.pending[pollId];
    if (!pending) return null;
    this.pendingDevice.set(pollId, pending);
    return pending;
  }

  private clearPendingDevice(pollId: string): void {
    this.pendingDevice.delete(pollId);
    const persisted = this.loadPersistedDeviceState();
    if (persisted.pending[pollId]) {
      delete persisted.pending[pollId];
      this.savePersistedDeviceState(persisted);
    }
  }

  private setPendingBrowser(pending: PendingAuth): void {
    this.pending.set(pending.state, pending);
    const persisted = this.loadPersistedState();
    persisted.pending[pending.state] = {
      createdAt: Date.now(),
      verifier: pending.verifier,
      redirectUri: pending.redirectUri,
    };
    delete persisted.results[pending.state];
    this.savePersistedState(persisted);
  }

  private getPendingBrowser(state: string): PendingAuth | null {
    const cached = this.pending.get(state);
    if (cached) return cached;

    const persisted = this.loadPersistedState();
    const pending = persisted.pending[state];
    if (!pending || !pending.verifier || !pending.redirectUri) return null;

    const restored = {
      state,
      verifier: pending.verifier,
      redirectUri: pending.redirectUri,
    };
    this.pending.set(state, restored);
    return restored;
  }

  private setBrowserResult(
    state: string,
    result: { status: 'authorized'; token: Record<string, unknown> } | { status: 'error'; error: string },
  ): void {
    this.pending.delete(state);
    this.browserResults.set(state, result);
    const persisted = this.loadPersistedState();
    delete persisted.pending[state];
    persisted.results[state] = result;
    this.savePersistedState(persisted);
  }

  private resolveRedirectUri(callbackBaseUrl?: string | null): string {
    const baseUrl = normalizeBaseUrl(callbackBaseUrl || PUBLIC_BASE_URL);
    if (!baseUrl || isLoopbackBaseUrl(baseUrl)) return LOCAL_OAUTH_REDIRECT_URI;
    return `${baseUrl}${HOST_OAUTH_CALLBACK_PATH}`;
  }

  private challenge(verifier: string): string {
    const digest = createHash('sha256').update(verifier, 'utf-8').digest();
    return Buffer.from(digest).toString('base64url');
  }

  private extractAccountId(payload: Record<string, unknown>): string | null {
    let claims: Record<string, unknown> | null = null;
    if (typeof payload.id_token === 'string' && payload.id_token) {
      claims = decodeClaims(payload.id_token);
    }
    if (!claims && typeof payload.access_token === 'string' && payload.access_token) {
      claims = decodeClaims(payload.access_token);
    }
    if (!claims) return null;

    const nestedAuth = claims['https://api.openai.com/auth'];
    const organizations = claims.organizations;
    const org0 = Array.isArray(organizations) && organizations[0] && typeof organizations[0] === 'object'
      ? (organizations[0] as Record<string, unknown>)
      : null;

    return (
      (typeof claims.chatgpt_account_id === 'string' ? claims.chatgpt_account_id : '') ||
      (nestedAuth && typeof nestedAuth === 'object' && typeof (nestedAuth as Record<string, unknown>).chatgpt_account_id === 'string'
        ? ((nestedAuth as Record<string, unknown>).chatgpt_account_id as string)
        : '') ||
      (org0 && typeof org0.id === 'string' ? org0.id : '') ||
      null
    );
  }

  private extractProfile(payload: Record<string, unknown>): { email?: string; displayName?: string } {
    let claims: Record<string, unknown> | null = null;
    if (typeof payload.id_token === 'string' && payload.id_token) {
      claims = decodeClaims(payload.id_token);
    }
    if (!claims && typeof payload.access_token === 'string' && payload.access_token) {
      claims = decodeClaims(payload.access_token);
    }
    if (!claims) return {};

    const email = typeof claims.email === 'string' && claims.email.trim() ? claims.email.trim() : '';
    const displayName =
      (typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : '') ||
      (typeof claims.preferred_username === 'string' && claims.preferred_username.trim() ? claims.preferred_username.trim() : '');

    return {
      ...(email ? { email } : {}),
      ...(displayName ? { displayName } : {}),
    };
  }

  private normalizeTokens(payload: Record<string, unknown>): Record<string, unknown> {
    const expiresIn = Number(payload.expires_in || 3600) || 3600;
    const profile = this.extractProfile(payload);
    return {
      type: 'oauth',
      access: String(payload.access_token || ''),
      refresh: String(payload.refresh_token || ''),
      expires: Date.now() + expiresIn * 1000,
      accountId: this.extractAccountId(payload),
      email: profile.email || null,
      displayName: profile.displayName || null,
    };
  }

  async startBrowserFlow(options: { callbackBaseUrl?: string | null } = {}): Promise<{ authorization_url: string; state: string }> {
    const verifier = tokenUrlSafe(48);
    const state = tokenUrlSafe(18);
    const redirectUri = this.resolveRedirectUri(options.callbackBaseUrl);

    if (redirectUri === LOCAL_OAUTH_REDIRECT_URI) {
      await this.ensureOauthServer();
    }

    this.setPendingBrowser({ state, verifier, redirectUri });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: 'openid profile email offline_access',
      code_challenge: this.challenge(verifier),
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      state,
      originator: OAUTH_ORIGINATOR,
    });

    return { authorization_url: `${ISSUER}/oauth/authorize?${params.toString()}`, state };
  }

  private async ensureOauthServer(): Promise<void> {
    if (this.oauthServer) return;
    if (this.oauthServerStarting) return;

    this.oauthServerStarting = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const server = createServer(async (req, res) => {
          try {
            const parsed = new URL(req.url || '/', `http://127.0.0.1:${OAUTH_PORT}`);
            if (req.method !== 'GET' || parsed.pathname !== '/auth/callback') {
              const notFound = '<!doctype html><html><body><h3>Not found</h3></body></html>';
              res.statusCode = 404;
              res.setHeader('Content-Type', 'text/html; charset=utf-8');
              res.end(notFound);
              return;
            }

            const code = parsed.searchParams.get('code');
            const state = parsed.searchParams.get('state');
            const error = parsed.searchParams.get('error_description') || parsed.searchParams.get('error');
            const result = await this.handleBrowserCallback({ code, state, error });
            const safe = String(result.message || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const body = [
              '<!doctype html><html><body style="font-family:sans-serif;padding:24px">',
              `<h3>${safe}</h3>`,
              '<p>You can close this tab and return to the Legal Assistant.</p>',
              '</body></html>',
            ].join('');

            res.statusCode = result.status;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(body);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end(message);
          }
        });

        server.on('error', (error) => {
          reject(error);
        });

        server.listen(OAUTH_PORT, '127.0.0.1', () => {
          this.oauthServer = server;
          resolve();
        });
      });
    } finally {
      this.oauthServerStarting = false;
    }
  }

  async completeBrowserFlow(code: string, state: string): Promise<Record<string, unknown>> {
    const pending = this.getPendingBrowser(state);
    if (!pending) throw new Error('Invalid or expired OAuth state');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pending.verifier,
    });

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${text.slice(0, 300)}`);
    }

    const tokens = (await response.json()) as Record<string, unknown>;
    this.pending.delete(state);
    return this.normalizeTokens(tokens);
  }

  async refresh(refreshToken: string): Promise<Record<string, unknown>> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    });

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token refresh failed (${response.status}): ${text.slice(0, 300)}`);
    }

    return this.normalizeTokens((await response.json()) as Record<string, unknown>);
  }

  async startDeviceFlow(): Promise<{ poll_id: string; verification_url: string; user_code: string; interval_ms: number }> {
    const response = await fetch(DEVICE_USERCODE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `${OAUTH_ORIGINATOR}/0.1`,
      },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to start device auth (${response.status}): ${text.slice(0, 300)}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const pollId = tokenUrlSafe(12);
    const intervalMs = Math.max(Number(data.interval || 5), 1) * 1000;

    this.setPendingDevice(pollId, {
      device_auth_id: String(data.device_auth_id || ''),
      user_code: String(data.user_code || ''),
      interval_ms: intervalMs,
      created_at: Date.now(),
    });

    return {
      poll_id: pollId,
      verification_url: `${ISSUER}/codex/device`,
      user_code: String(data.user_code || ''),
      interval_ms: intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS,
    };
  }

  async pollDeviceFlow(pollId: string): Promise<{ status: 'pending' | 'authorized'; token?: Record<string, unknown> }> {
    const pending = this.getPendingDevice(pollId);
    if (!pending) throw new Error('Invalid or expired device auth poll id');

    const response = await fetch(DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `${OAUTH_ORIGINATOR}/0.1`,
      },
      body: JSON.stringify({
        device_auth_id: String(pending.device_auth_id || ''),
        user_code: String(pending.user_code || ''),
      }),
    });

    if (response.status === 403 || response.status === 404) {
      return { status: 'pending' };
    }

    if (!response.ok) {
      this.clearPendingDevice(pollId);
      const text = await response.text();
      throw new Error(`Device auth poll failed (${response.status}): ${text.slice(0, 300)}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(data.authorization_code || ''),
      redirect_uri: `${ISSUER}/deviceauth/callback`,
      client_id: CLIENT_ID,
      code_verifier: String(data.code_verifier || ''),
    });

    const tokenResponse = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
    });

    if (!tokenResponse.ok) {
      this.clearPendingDevice(pollId);
      const text = await tokenResponse.text();
      throw new Error(`Token exchange failed (${tokenResponse.status}): ${text.slice(0, 300)}`);
    }

    this.clearPendingDevice(pollId);
    const token = this.normalizeTokens((await tokenResponse.json()) as Record<string, unknown>);
    return { status: 'authorized', token };
  }

  pollBrowserFlow(state: string): BrowserResult {
    const persisted = this.loadPersistedState();

    if (this.browserResults.has(state)) {
      const result = this.browserResults.get(state) as BrowserResult;
      this.browserResults.delete(state);
      delete persisted.results[state];
      delete persisted.pending[state];
      this.savePersistedState(persisted);
      return result;
    }
    if (persisted.results[state]) {
      const result = persisted.results[state];
      delete persisted.results[state];
      delete persisted.pending[state];
      this.savePersistedState(persisted);
      return result;
    }
    if (this.pending.has(state) || persisted.pending[state]) return { status: 'pending' };
    return { status: 'pending' };
  }

  async handleBrowserCallback(params: {
    code?: string | null;
    state?: string | null;
    error?: string | null;
  }): Promise<{ status: number; message: string }> {
    const { code, state, error } = params;
    if (!state || !this.getPendingBrowser(state)) {
      return { status: 400, message: 'Invalid state' };
    }
    if (error) {
      this.setBrowserResult(state, { status: 'error', error });
      return { status: 400, message: `Authorization failed: ${error}` };
    }
    if (!code) {
      this.setBrowserResult(state, { status: 'error', error: 'Missing authorization code' });
      return { status: 400, message: 'Missing authorization code' };
    }

    try {
      const token = await this.completeBrowserFlow(code, state);
      this.setBrowserResult(state, { status: 'authorized', token });
      return { status: 200, message: 'Authorization complete. You can close this window.' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setBrowserResult(state, { status: 'error', error: msg });
      return { status: 400, message: `Authorization failed: ${msg}` };
    }
  }
}

const singleton = new CodexOAuth();

export function codexOauth(): CodexOAuth {
  return singleton;
}
