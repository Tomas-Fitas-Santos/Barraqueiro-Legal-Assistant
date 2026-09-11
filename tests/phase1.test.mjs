import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// Phase 1 — Microsoft 365 config surface and the library, exercised WITHOUT any real
// Graph tenant: config persistence, secret write-only masking, the not-configured
// degradation paths, and the documents table read/download paths (rows seeded directly
// into the throwaway SQLite, the setup the HTTP API cannot do without a live tenant).

describe('phase 1 — msgraph config + library degradation', () => {
  before(async () => {
    // No drive at all: this suite is about what a fresh, unconfigured install does.
    await startServer({ env: { LEGAL_FAKE_GRAPH: '' } });
  });
  after(async () => {
    await stopServer();
  });

  it('gates the new APIs on the session', async () => {
    for (const [method, p] of [
      ['GET', '/api/msgraph/config'],
      ['PATCH', '/api/msgraph/config'],
      ['POST', '/api/msgraph/authorize'],
      ['GET', '/api/msgraph/folders'],
      ['POST', '/api/msgraph/folder'],
      ['POST', '/api/msgraph/disconnect'],
      ['GET', '/api/library/documents'],
      ['POST', '/api/library/sync'],
    ]) {
      const res = await api(p, { method });
      assert.equal(res.status, 401, `${method} ${p} must 401 without a session`);
    }
  });

  it('starts unconfigured: health row, config flags, authorize refusal, sync refusal', async () => {
    const jar = await loginAdmin();

    const health = await api('/api/health', { jar });
    const ms = health.data.rows.find((row) => row.name === 'Microsoft 365');
    assert.equal(ms.status, 'not_configured');

    const config = await api('/api/msgraph/config', { jar });
    assert.equal(config.data.configured, false);
    assert.equal(config.data.clientSecretSet, false);

    const authorize = await api('/api/msgraph/authorize', { method: 'POST', jar });
    assert.equal(authorize.status, 400);
    assert.match(authorize.data.error, /not configured/i);

    const sync = await api('/api/library/sync', { method: 'POST', jar });
    assert.equal(sync.status, 400);
  });

  it('persists the registration; the client secret is write-only', async () => {
    const jar = await loginAdmin();
    const save = await api('/api/msgraph/config', {
      method: 'PATCH',
      body: { tenantId: 'tenant-123', clientId: 'client-456', clientSecret: 'super-secret' },
      jar,
    });
    assert.equal(save.data.ok, true);
    assert.equal(save.data.configured, true);

    const config = await api('/api/msgraph/config', { jar });
    assert.equal(config.data.tenantId, 'tenant-123');
    assert.equal(config.data.clientId, 'client-456');
    assert.equal(config.data.clientSecretSet, true);
    assert.equal(JSON.stringify(config.data).includes('super-secret'), false);

    // Absent secret field leaves the stored secret untouched.
    await api('/api/msgraph/config', { method: 'PATCH', body: { tenantId: 'tenant-123' }, jar });
    const again = await api('/api/msgraph/config', { jar });
    assert.equal(again.data.clientSecretSet, true);

    // Configured but not signed in: authorize now works (returns the Microsoft URL)…
    const authorize = await api('/api/msgraph/authorize', { method: 'POST', jar });
    assert.equal(authorize.data.ok, true);
    assert.match(authorize.data.authorizationUrl, /^https:\/\/login\.microsoftonline\.com\/tenant-123\//);
    assert.match(authorize.data.authorizationUrl, /Files\.ReadWrite/);
    assert.equal(authorize.data.authorizationUrl.includes('Mail.Send'), false);
    // The OAuth redirect must round-trip through the PUBLIC base URL, never the
    // container bind address (regression: behind the proxy, redirects went to 0.0.0.0).
    const redirectUri = decodeURIComponent(
      String(authorize.data.authorizationUrl.match(/redirect_uri=([^&]+)/)[1]),
    );
    const { BASE } = await import('./helpers.mjs');
    assert.equal(redirectUri, `${BASE}/api/msgraph/callback`);

    // …and health moves to the next setup step, still not_configured.
    const health = await api('/api/health', { jar });
    const ms = health.data.rows.find((row) => row.name === 'Microsoft 365');
    assert.equal(ms.status, 'not_configured');
    assert.match(ms.detail, /sign in/i);
  });

  it('rejects a callback with a bad state and redirects with the error', async () => {
    const { BASE } = await import('./helpers.mjs');
    const res = await fetch(`${BASE}/api/msgraph/callback?code=x&state=bogus`, { redirect: 'manual' });
    assert.equal(res.status, 307);
    const location = String(res.headers.get('location'));
    assert.ok(location.includes('/settings'));
    assert.ok(location.includes('ms=error'));
  });

  it('lists documents from the mirror and 404s an unknown download', async () => {
    const jar = await loginAdmin();

    const empty = await api('/api/library/documents', { jar });
    assert.equal(empty.data.ok, true);
    assert.deepEqual(empty.data.documents, []);

    // Seed a document row directly — the delta feed is the only writer in production.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
    const now = Date.now();
    db.prepare(
      `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
       VALUES ('doc_test1', 'item-1', 'PPRC.pdf', 'Planos', 'application/pdf', 12345, 'listed', 0, ?, ?, ?)`,
    ).run(now, now, now);
    db.prepare(
      `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
       VALUES ('doc_gone', 'item-2', 'Antigo.pdf', '', 'application/pdf', 1, 'listed', 1, ?, ?, ?)`,
    ).run(now, now, now);
    db.close();

    const listed = await api('/api/library/documents', { jar });
    assert.equal(listed.data.documents.length, 1);
    assert.equal(listed.data.documents[0].name, 'PPRC.pdf');
    assert.equal(listed.data.documents[0].path, 'Planos');
    assert.equal(listed.data.documents[0].state, 'listed');

    const withRemoved = await api('/api/library/documents?includeRemoved=1', { jar });
    assert.equal(withRemoved.data.documents.length, 2);

    const missing = await api('/api/library/documents/doc_nope/download', { jar });
    assert.equal(missing.status, 404);

    // Known row but no connected account: graceful error, not a crash.
    const noAccount = await api('/api/library/documents/doc_test1/download', { jar });
    assert.equal(noAccount.status, 400);
    assert.match(noAccount.data.error, /not connected/i);
  });
});
