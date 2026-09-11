'use client';

import { useCallback, useEffect, useState } from 'react';

import { Card } from '@/components/ui/page';
import { PasswordInput } from '@/components/ui/password-input';

// Microsoft 365 setup, in the order it actually happens: (1) the app registration from
// Barraqueiro's tenant (see docs/registo-aplicacao-m365.md), (2) delegated sign-in with
// the legal user's Microsoft account, (3) picking the OneDrive library folder.

type GraphConfig = {
  tenantId: string;
  clientId: string;
  clientSecretSet: boolean;
  configured: boolean;
  connected: boolean;
  accountEmail: string;
  accountName: string;
  libraryConfigured: boolean;
  libraryFolderName: string;
};

type GraphFolder = { id: string; name: string; childCount: number };

export function MsGraphCard() {
  const [config, setConfig] = useState<GraphConfig | null>(null);
  const [tenantId, setTenantId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [picker, setPicker] = useState<{ parentId: string; trail: GraphFolder[]; folders: GraphFolder[] } | null>(null);

  const refresh = useCallback(async () => {
    const data = await fetch('/api/msgraph/config').then((r) => r.json());
    if (data.ok) {
      setConfig(data);
      setTenantId(data.tenantId);
      setClientId(data.clientId);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Callback outcome arrives as query params on the redirect back to /settings.
    const params = new URLSearchParams(window.location.search);
    if (params.get('ms') === 'connected') setNotice('Microsoft account connected.');
    if (params.get('ms') === 'error') setError(params.get('msDetail') || 'Microsoft sign-in failed.');
    if (params.has('ms')) window.history.replaceState(null, '', '/settings');
  }, [refresh]);

  async function saveRegistration(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    const body: Record<string, string> = { tenantId, clientId };
    if (clientSecret) body.clientSecret = clientSecret;
    const data = await fetch('/api/msgraph/config', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    if (!data.ok) {
      setError(data.error || 'Could not save.');
      return;
    }
    setClientSecret('');
    setNotice('App registration saved.');
    await refresh();
  }

  async function signIn() {
    setError('');
    const data = await fetch('/api/msgraph/authorize', { method: 'POST' }).then((r) => r.json());
    if (!data.ok) {
      setError(data.error || 'Could not start the Microsoft sign-in.');
      return;
    }
    window.location.href = data.authorizationUrl;
  }

  async function disconnect() {
    await fetch('/api/msgraph/disconnect', { method: 'POST' });
    setPicker(null);
    await refresh();
  }

  async function openPicker(parentId = '', trail: GraphFolder[] = []) {
    setError('');
    const data = await fetch(`/api/msgraph/folders?parentId=${encodeURIComponent(parentId)}`).then((r) => r.json());
    if (!data.ok) {
      setError(data.error || 'Could not list OneDrive folders.');
      return;
    }
    setPicker({ parentId, trail, folders: data.folders });
  }

  async function chooseFolder(folder: GraphFolder) {
    const data = await fetch('/api/msgraph/folder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: folder.id, folderName: folder.name }),
    }).then((r) => r.json());
    if (!data.ok) {
      setError(data.error || 'Could not select the folder.');
      return;
    }
    setPicker(null);
    const created = Array.isArray(data.created) ? data.created.length : 0;
    setNotice(
      `Library folder set to "${folder.name}" — first sync started${created ? `, ${created} folder(s) created` : ''}.`,
    );
    await refresh();
  }

  return (
    <Card>
      <h2 className="m-0 text-xl font-semibold text-ink0">Microsoft 365</h2>
      <p className="mt-1.5 mb-5 text-base ui-text-muted">
        The document library lives in the client&apos;s own OneDrive. Setup: app registration →
        sign-in → library folder.
      </p>

      <form onSubmit={saveRegistration} className="grid gap-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <label htmlFor="ms-tenant" className="text-sm font-medium text-ink1">
              Tenant ID
            </label>
            <input
              id="ms-tenant"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              className="ui-input rounded-md px-3 py-2"
            />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="ms-client" className="text-sm font-medium text-ink1">
              Client ID
            </label>
            <input
              id="ms-client"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="ui-input rounded-md px-3 py-2"
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="ms-secret" className="text-sm font-medium text-ink1">
            Client secret{config?.clientSecretSet ? ' (stored — leave blank to keep)' : ''}
          </label>
          <PasswordInput
            id="ms-secret"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div>
          <button type="submit" className="ui-btn-secondary rounded-md px-3.5 py-1.5 text-base">
            Save registration
          </button>
        </div>
      </form>

      <div className="mt-5 border-t border-line0 pt-5">
        {config?.connected ? (
          <div className="grid gap-3">
            <p className="m-0 text-base">
              <span className="ui-pill-ok mr-2 rounded-md px-2 py-0.5 text-sm">Signed in</span>
              {config.accountName || config.accountEmail}
              {config.accountEmail && config.accountName ? ` · ${config.accountEmail}` : ''}
            </p>
            {config.libraryConfigured ? (
              <p className="m-0 text-base">
                Library folder: <span className="font-medium text-ink0">{config.libraryFolderName}</span>{' '}
                <button type="button" onClick={() => openPicker()} className="ui-link ml-2 text-sm">
                  Change
                </button>
              </p>
            ) : (
              <div>
                <button type="button" onClick={() => openPicker()} className="ui-btn-primary rounded-md px-4 py-2 text-base">
                  Pick the library folder
                </button>
              </div>
            )}
            <div>
              <button type="button" onClick={disconnect} className="ui-btn-secondary rounded-md px-3.5 py-1.5 text-base">
                Disconnect account
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={signIn}
            disabled={!config?.configured}
            className="ui-btn-primary rounded-md px-4 py-2 text-base disabled:cursor-not-allowed disabled:opacity-60"
          >
            Sign in with Microsoft
          </button>
        )}
      </div>

      {picker ? (
        <div className="ui-soft-panel mt-5 grid gap-3 rounded-lg p-5">
          <div className="flex flex-wrap items-center gap-1 text-sm">
            <button type="button" onClick={() => openPicker()} className="ui-link">
              OneDrive root
            </button>
            {picker.trail.map((crumb, index) => (
              <span key={crumb.id}>
                {' / '}
                <button
                  type="button"
                  onClick={() => openPicker(crumb.id, picker.trail.slice(0, index + 1))}
                  className="ui-link"
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </div>
          {picker.folders.length === 0 ? (
            <p className="m-0 text-sm ui-text-muted">No subfolders here.</p>
          ) : (
            <ul className="m-0 grid list-none gap-1 p-0">
              {picker.folders.map((folder) => (
                <li key={folder.id} className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => openPicker(folder.id, [...picker.trail, folder])}
                    className="ui-link text-base"
                  >
                    {folder.name}/
                  </button>
                  <button
                    type="button"
                    onClick={() => chooseFolder(folder)}
                    className="ui-btn-secondary rounded-md px-3 py-1 text-sm"
                  >
                    Use this folder
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div>
            <button type="button" onClick={() => setPicker(null)} className="ui-link text-sm">
              Close
            </button>
          </div>
        </div>
      ) : null}

      {notice ? <p className="mt-4 mb-0 text-base ui-text-muted">{notice}</p> : null}
      {error ? <p className="mt-4 mb-0 text-base text-danger">{error}</p> : null}
    </Card>
  );
}
