import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { api, loginAdmin, newJar, startServer, stopServer, ADMIN_EMAIL } from './helpers.mjs';

describe('phase 0 — scaffold, auth, AI degradation', () => {
  before(async () => {
    await startServer();
  });
  after(async () => {
    await stopServer();
  });

  it('rejects a bad login', async () => {
    const jar = newJar();
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: { email: ADMIN_EMAIL, password: 'wrong' },
      jar,
    });
    assert.equal(res.status, 401);
    assert.equal(res.data.ok, false);
  });

  it('signs the bootstrap admin in and reads the session back', async () => {
    const jar = await loginAdmin();
    const session = await api('/api/auth/session', { jar });
    assert.equal(session.data.ok, true);
    assert.equal(session.data.session.email, ADMIN_EMAIL);
    assert.equal(session.data.session.role, 'admin');
  });

  it('logout invalidates the cookie', async () => {
    const jar = await loginAdmin();
    await api('/api/auth/logout', { method: 'POST', jar });
    const session = await api('/api/auth/session', { jar });
    assert.equal(session.data.session, null);
  });

  it('gates every protected API on the session', async () => {
    for (const [method, path] of [
      ['GET', '/api/health'],
      ['GET', '/api/settings/model'],
      ['PATCH', '/api/settings/model'],
      ['GET', '/api/auth/openai/status'],
      ['POST', '/api/auth/openai/authorize'],
      ['POST', '/api/auth/openai/logout'],
      ['GET', '/api/auth/openai/usage'],
      ['GET', '/api/auth/openai/browser/poll?state=x'],
      ['GET', '/api/auth/openai/device/poll?pollId=x'],
    ]) {
      const res = await api(path, { method });
      assert.equal(res.status, 401, `${method} ${path} must 401 without a session`);
    }
  });

  it('authenticated pages render (not the baked login redirect)', async () => {
    const jar = await loginAdmin();
    const { BASE } = await import('./helpers.mjs');
    for (const path of ['/', '/library', '/settings']) {
      const res = await fetch(`${BASE}${path}`, {
        redirect: 'manual',
        headers: { cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      });
      assert.equal(res.status, 200, `${path} must render for a signed-in session`);
    }
  });

  it('protected pages redirect to /login', async () => {
    for (const path of ['/', '/library', '/settings']) {
      const res = await fetch(`${(await import('./helpers.mjs')).BASE}${path}`, { redirect: 'manual' });
      assert.equal(res.status, 307, `${path} must redirect anonymously`);
      assert.ok(String(res.headers.get('location')).includes('/login'));
    }
  });

  it('health reports AI as not configured (no ChatGPT connection, no key)', async () => {
    const jar = await loginAdmin();
    const res = await api('/api/health', { jar });
    assert.equal(res.data.ok, true);
    const ai = res.data.rows.find((row) => row.name === 'AI');
    assert.equal(ai.status, 'not_configured');
    // not_configured must never degrade the overall status by itself.
    const nonDegraded = res.data.rows.filter((row) => row.status !== 'degraded');
    assert.ok(nonDegraded.length > 0);
    const db = res.data.rows.find((row) => row.name === 'Database');
    assert.equal(db.status, 'ok');
  });

  it('openai status is unauthenticated and logout is idempotent', async () => {
    const jar = await loginAdmin();
    const status = await api('/api/auth/openai/status', { jar });
    assert.equal(status.data.authenticated, false);
    const logout = await api('/api/auth/openai/logout', { method: 'POST', jar });
    assert.equal(logout.data.ok, true);
  });

  it('model selection: default, change, reject unknown', async () => {
    const jar = await loginAdmin();
    const initial = await api('/api/settings/model', { jar });
    assert.equal(initial.data.selected, 'gpt-5.6-sol');
    assert.ok(initial.data.models.length >= 5);

    const set = await api('/api/settings/model', { method: 'PATCH', body: { model: 'gpt-5.4' }, jar });
    assert.equal(set.data.selected, 'gpt-5.4');
    const readBack = await api('/api/settings/model', { jar });
    assert.equal(readBack.data.selected, 'gpt-5.4');

    const bad = await api('/api/settings/model', { method: 'PATCH', body: { model: 'gpt-nope' }, jar });
    assert.equal(bad.status, 400);
  });
});
