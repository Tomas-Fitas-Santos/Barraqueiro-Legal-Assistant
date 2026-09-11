import { ApiError } from '@/app/api/_helpers';
import { getSetting, setSetting } from '@/lib/server/db';
import * as fake from '@/lib/server/graph-fake';
import { getSecretSetting, setSecretSetting } from '@/lib/server/secrets';

// Microsoft Graph for the client's OneDrive document library. Same shape as the proven
// Naten Drive client (helpdesk gdrive.ts): no SDK, a handful of REST endpoints over fetch,
// in-memory access-token cache, one 401 retry with a fresh token.
//
// The identity is DELEGATED: the legal user signs in with their own Microsoft account (in
// Barraqueiro's tenant) and the app acts as them — the library is a folder THEY own. The
// app registration lives in the client's tenant; see docs/registo-aplicacao-m365.md.
//
// Microsoft-specific: refresh tokens ROTATE — every refresh returns a new one, and the old
// one eventually stops working. Every refresh therefore persists the rotated token.

const GRAPH = 'https://graph.microsoft.com/v1.0';

// Delegated permissions. Mail.ReadWrite is deliberately absent until phase 7 (optional
// Outlook drafts); Mail.Send is never requested — the app must be unable to send.
const SCOPES = 'offline_access User.Read Files.ReadWrite';

export const GRAPH_CALLBACK_PATH = '/api/msgraph/callback';

/**
 * The app's public origin for OAuth round-trips and post-callback redirects.
 * LEGAL_PUBLIC_BASE_URL wins when set (behind the proxy, Next's own request URL reports
 * the container bind address 0.0.0.0:3000 — useless in a browser); otherwise derive from
 * forwarded/request headers (correct for localhost dev).
 */
export function appBaseUrl(req: Request): string {
  const configured = String(process.env.LEGAL_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const url = new URL(req.url);
  const forwardedHost = String(req.headers.get('x-forwarded-host') || '').split(',')[0].trim();
  const host = forwardedHost || String(req.headers.get('host') || '').split(',')[0].trim();
  if (!host) return url.origin;
  const proto = String(req.headers.get('x-forwarded-proto') || '').split(',')[0].trim() ||
    url.protocol.replace(/:$/, '') || 'http';
  return `${proto}://${host}`;
}

function tenantId(): string {
  return String(getSetting('graph.tenant_id') || '').trim();
}

function clientId(): string {
  return String(getSetting('graph.client_id') || '').trim();
}

function authority(): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId())}/oauth2/v2.0`;
}

/** App registration present (tenant + client id + client secret). */
export function isGraphConfigured(): boolean {
  return Boolean(tenantId() && clientId() && getSecretSetting('graph.client_secret'));
}

/** A Microsoft account is connected (signed in, refresh token stored). */
export function isGraphConnected(): boolean {
  return isGraphConfigured() && Boolean(getSecretSetting('graph.refresh_token'));
}

/**
 * The library folder has been chosen — everything the app needs to sync.
 *
 * Under the test fake the drive exists without an app registration or a token, but the
 * FOLDER still has to be chosen, exactly as in the real thing. Keeping that second step
 * real is what lets the suite go on testing a fresh, unconfigured install.
 */
export function isLibraryConfigured(): boolean {
  const folderChosen = Boolean(String(getSetting('graph.library_folder_id') || '').trim());
  if (fake.fakeMode()) return folderChosen;
  return isGraphConnected() && folderChosen;
}

/**
 * Can the app fetch bytes from the drive at all?
 *
 * Distinct from `isGraphConnected()`, which asks whether a Microsoft account is linked. The
 * question the ingest pipeline actually needs answered is "will `downloadItem` work", and
 * under the test fake it will — the drive is a directory. Conflating the two meant every
 * synced document failed to ingest against the fake with a message about Microsoft 365.
 */
export function canReachDrive(): boolean {
  return fake.fakeMode() || isGraphConnected();
}

/** The library folder's id, or '' when no folder has been chosen yet. */
export function libraryFolderId(): string {
  return String(getSetting('graph.library_folder_id') || '').trim();
}

// --- OAuth (delegated auth-code flow) ------------------------------------

export function buildAuthorizeUrl(redirectUri: string, state: string): string {
  if (!isGraphConfigured()) {
    throw new ApiError('Microsoft 365 is not configured — add the app registration in Settings first.', 400);
  }
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    state,
  });
  return `${authority()}/authorize?${params.toString()}`;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

async function tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(`${authority()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    throw new ApiError(`Microsoft sign-in failed: ${String(detail).slice(0, 300)}`, 502);
  }
  return data;
}

export async function exchangeAuthCode(code: string, redirectUri: string): Promise<void> {
  if (fake.fakeMode()) {
    // "Signing in" to the fake is choosing which account it is: `fake:<account>`. The route
    // around it is the real one, so switching accounts exercises the production callback.
    const account = code.startsWith('fake:') ? code.slice(5) : fake.fakeAccount();
    fake.setFakeAccount(account);
    setSecretSetting('graph.refresh_token', `fake-refresh-${account}`);
    const who = await whoAmI();
    setSetting('graph.account_email', who.email);
    setSetting('graph.account_name', who.name);
    return;
  }
  const data = await tokenRequest(
    new URLSearchParams({
      client_id: clientId(),
      client_secret: getSecretSetting('graph.client_secret'),
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      scope: SCOPES,
    }),
  );
  if (!data.refresh_token) {
    throw new ApiError('Microsoft did not return a refresh token — check that offline_access is consented.', 502);
  }
  setSecretSetting('graph.refresh_token', data.refresh_token);
  cachedToken = {
    token: String(data.access_token),
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  // Record who connected, for the Settings page and health.
  const me = await whoAmI();
  setSetting('graph.account_email', me.email);
  setSetting('graph.account_name', me.name);
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.token;
  const refresh = getSecretSetting('graph.refresh_token');
  if (!refresh) throw new ApiError('Microsoft account is not connected — sign in from Settings.', 400);
  const data = await tokenRequest(
    new URLSearchParams({
      client_id: clientId(),
      client_secret: getSecretSetting('graph.client_secret'),
      grant_type: 'refresh_token',
      refresh_token: refresh,
      scope: SCOPES,
    }),
  );
  // Rotation: persist the replacement refresh token or a later refresh will fail.
  if (data.refresh_token && data.refresh_token !== refresh) {
    setSecretSetting('graph.refresh_token', data.refresh_token);
  }
  cachedToken = {
    token: String(data.access_token),
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  return cachedToken.token;
}

export function disconnectGraph(): void {
  setSecretSetting('graph.refresh_token', '');
  setSetting('graph.account_email', '');
  setSetting('graph.account_name', '');
  cachedToken = null;
}

// --- Graph fetch ----------------------------------------------------------

export async function graphFetch(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
  const token = await accessToken();
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401) {
    // One retry with a fresh token — the cached one can be revoked out from under us.
    cachedToken = null;
    return fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${await accessToken()}` },
      signal: AbortSignal.timeout(60_000),
    });
  }
  return res;
}

async function graphJson<T>(pathOrUrl: string, init: RequestInit = {}): Promise<T> {
  const res = await graphFetch(pathOrUrl, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(`Microsoft Graph error ${res.status}: ${text.slice(0, 300)}`, 502);
  }
  return (await res.json()) as T;
}

// --- Typed helpers --------------------------------------------------------

export async function whoAmI(): Promise<{ name: string; email: string }> {
  if (fake.fakeMode()) {
    return { name: `Conta ${fake.fakeAccount().toUpperCase()}`, email: fake.fakeAccountEmail() };
  }
  const me = await graphJson<{ displayName?: string; mail?: string; userPrincipalName?: string }>('/me');
  return {
    name: String(me.displayName || ''),
    email: String(me.mail || me.userPrincipalName || ''),
  };
}

export type GraphFolder = { id: string; name: string; childCount: number };

/** Child folders of a OneDrive folder ('' = the drive root) — the folder picker. */
export async function listChildFolders(parentId: string): Promise<GraphFolder[]> {
  if (fake.fakeMode()) {
    return fake
      .fakeWalk()
      .filter((item) => item.isFolder && item.parentId === (parentId || fake.fakeRootId()))
      .map((item) => ({ id: item.id, name: item.name, childCount: 0 }));
  }
  const path = parentId
    ? `/me/drive/items/${encodeURIComponent(parentId)}/children`
    : '/me/drive/root/children';
  const data = await graphJson<{
    value: Array<{ id: string; name: string; folder?: { childCount?: number } }>;
  }>(`${path}?$select=id,name,folder&$top=200`);
  return data.value
    .filter((item) => item.folder)
    .map((item) => ({ id: item.id, name: item.name, childCount: Number(item.folder?.childCount || 0) }));
}

/**
 * A folder's absolute Graph path, e.g. "/drive/root:/Legal/Biblioteca".
 *
 * Resolved from the item rather than asked of the caller: the folder picker only knows ids
 * and names, and a path supplied by the client would be one more thing that can be wrong.
 */
export async function folderAbsolutePath(folderId: string): Promise<string> {
  if (fake.fakeMode()) {
    const relative = fake.fakePathOf(folderId);
    return relative ? `${fake.fakeRootPath()}/${relative}` : fake.fakeRootPath();
  }
  const data = await graphJson<{ name?: string; parentReference?: { path?: string } }>(
    `/me/drive/items/${encodeURIComponent(folderId)}?$select=name,parentReference`,
  );
  const parent = String(data.parentReference?.path || '');
  const name = String(data.name || '');
  if (!parent || !name) return '';
  return `${parent}/${name}`;
}

export async function driveId(): Promise<string> {
  if (fake.fakeMode()) return fake.fakeDriveId();
  const data = await graphJson<{ id: string }>('/me/drive?$select=id');
  return data.id;
}

export type DeltaItem = {
  id: string;
  name?: string;
  eTag?: string;
  cTag?: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: Record<string, unknown>;
  deleted?: { state?: string };
  parentReference?: { id?: string; path?: string };
};

export type DeltaPage = {
  value: DeltaItem[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
};

/**
 * One page of the delta feed. First call passes the folder id; subsequent pages and later
 * incremental syncs pass the stored nextLink/deltaLink verbatim (they are full URLs).
 */
export async function deltaPage(folderIdOrLink: string): Promise<DeltaPage> {
  if (fake.fakeMode()) return fake.fakeDeltaPage(folderIdOrLink) as unknown as DeltaPage;
  const target = folderIdOrLink.startsWith('https://')
    ? folderIdOrLink
    : `/me/drive/items/${encodeURIComponent(folderIdOrLink)}/delta`;
  return graphJson<DeltaPage>(target);
}

/** Stream a file's content (Graph 302-redirects to a pre-authenticated URL; fetch follows). */
/**
 * Delete a drive item. The library IS the OneDrive folder, so a document deleted in the
 * app has to go there too — otherwise the next delta sync brings it straight back. Graph
 * moves it to the user's recycle bin, so this is recoverable on their side.
 */
export async function deleteItem(itemId: string): Promise<void> {
  if (fake.fakeMode()) return fake.fakeDeleteItem(itemId);
  const res = await graphFetch(`/me/drive/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
  // 404 means it is already gone — the end state the caller wanted.
  if (!res.ok && res.status !== 404) {
    throw new ApiError(`Could not delete the file on OneDrive (HTTP ${res.status}).`, 502);
  }
}

/** A name conflict on the drive. Distinguished so the UI can offer "keep both". */
export class DriveConflictError extends ApiError {
  constructor(message: string) {
    super(message, 409);
    this.name = 'DriveConflictError';
  }
}

export type DriveItem = {
  id: string;
  name: string;
  parentReference?: { id?: string; path?: string };
  folder?: Record<string, unknown>;
  file?: { mimeType?: string };
};

/** One item, or null when it is not there. */
export async function getItem(itemId: string): Promise<DriveItem | null> {
  if (fake.fakeMode()) {
    const item = fake.fakeItemById(itemId);
    return item
      ? {
          id: item.id,
          name: item.name,
          parentReference: { id: item.parentId, path: item.parentPath },
          ...(item.isFolder ? { folder: {} } : { file: {} }),
        }
      : null;
  }
  const res = await graphFetch(`/me/drive/items/${encodeURIComponent(itemId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(`Could not read the item from OneDrive (HTTP ${res.status}).`, 502);
  return (await res.json()) as DriveItem;
}

/**
 * Rename and/or move an item. The id is PRESERVED, which is the whole reason moving is done
 * this way rather than by copy-and-delete: the app's `drive_item_id` keeps pointing at the
 * same thing, so nothing re-ingests and no citation breaks.
 */
export async function patchItem(
  itemId: string,
  changes: { name?: string; parentId?: string },
): Promise<DriveItem> {
  if (fake.fakeMode()) {
    try {
      const item = fake.fakePatchItem(itemId, changes);
      return { id: item.id, name: item.name, parentReference: { id: item.parentId, path: item.parentPath } };
    } catch (error) {
      if ((error as { status?: number }).status === 409) {
        throw new DriveConflictError('Já existe um item com esse nome nessa pasta.');
      }
      throw new ApiError('Não foi possível mover ou mudar o nome do item no OneDrive.', 502);
    }
  }
  const body: Record<string, unknown> = {};
  if (changes.name !== undefined) body.name = changes.name;
  if (changes.parentId !== undefined) body.parentReference = { id: changes.parentId };
  const res = await graphFetch(`/me/drive/items/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 409) throw new DriveConflictError('Já existe um item com esse nome nessa pasta.');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(`OneDrive refused the change (HTTP ${res.status}): ${text.slice(0, 200)}`, 502);
  }
  return (await res.json()) as DriveItem;
}

/**
 * Create a child folder, refusing when the name is taken.
 *
 * Distinct from `ensureChildFolder`, which REUSES an existing folder — right when the app is
 * making sure its own structure exists, wrong when a person pressed "Nova pasta" and needs
 * to be told the name is taken.
 */
export async function createChildFolder(parentId: string, name: string): Promise<{ id: string; name: string }> {
  if (fake.fakeMode()) {
    try {
      return fake.fakeCreateFolder(parentId, name);
    } catch (error) {
      if ((error as { status?: number }).status === 409) {
        throw new DriveConflictError('Já existe uma pasta com esse nome.');
      }
      throw new ApiError('Não foi possível criar a pasta no OneDrive.', 502);
    }
  }
  const res = await graphFetch(`/me/drive/items/${encodeURIComponent(parentId)}/children`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
  });
  if (res.status === 409) throw new DriveConflictError('Já existe uma pasta com esse nome.');
  if (!res.ok) throw new ApiError(`Could not create the folder "${name}" (HTTP ${res.status}).`, 502);
  const data = (await res.json()) as { id: string; name: string };
  return { id: data.id, name: data.name };
}

export async function downloadItem(itemId: string): Promise<Response> {
  if (fake.fakeMode()) {
    try {
      return new Response(new Uint8Array(fake.fakeReadFile(itemId)));
    } catch {
      throw new ApiError('Could not download the file from OneDrive (HTTP 404).', 502);
    }
  }
  const res = await graphFetch(`/me/drive/items/${encodeURIComponent(itemId)}/content`);
  if (!res.ok) {
    throw new ApiError(`Could not download the file from OneDrive (HTTP ${res.status}).`, 502);
  }
  return res;
}
