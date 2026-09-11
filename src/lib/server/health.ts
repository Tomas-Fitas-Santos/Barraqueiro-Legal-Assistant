import { accessSync, constants } from 'node:fs';

import { aiConfigured, selectedModel } from '@/lib/server/ai/client';
import { loadCodexToken } from '@/lib/server/ai/vendor/codex-token-store';
import { getDb, getSetting } from '@/lib/server/db';
import { isGraphConfigured, isGraphConnected, isLibraryConfigured } from '@/lib/server/msgraph';
import { lastSync } from '@/lib/server/repo/library';
import { LEGAL_DATA_DIR } from '@/lib/server/paths';
import { isSecretsEncryptionAvailable, plaintextSecretCount } from '@/lib/server/secrets';

// System health, one row per subsystem. Vocabulary (kept deliberately small):
//   ok             — configured and working
//   not_configured — absent by configuration; the app degrades gracefully
//   degraded       — configured but currently not right
export type HealthStatus = 'ok' | 'not_configured' | 'degraded';

export type HealthRow = {
  name: string;
  status: HealthStatus;
  detail: string;
};

export type HealthReport = {
  status: HealthStatus; // worst row wins; not_configured never degrades the overall status
  rows: HealthRow[];
};

export async function healthReport(): Promise<HealthReport> {
  const rows: HealthRow[] = [];

  // Database + data dir
  try {
    getDb().prepare('SELECT 1').get();
    accessSync(LEGAL_DATA_DIR, constants.W_OK);
    rows.push({ name: 'Database', status: 'ok', detail: 'SQLite ready, data directory writable.' });
  } catch (error) {
    rows.push({
      name: 'Database',
      status: 'degraded',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // Sessions
  rows.push(
    process.env.LEGAL_SESSION_SECRET?.trim()
      ? { name: 'Sessions', status: 'ok', detail: 'Session secret configured.' }
      : { name: 'Sessions', status: 'degraded', detail: 'LEGAL_SESSION_SECRET is not set — nobody can sign in.' },
  );

  // Secrets at rest
  if (!isSecretsEncryptionAvailable()) {
    rows.push({
      name: 'Secrets at rest',
      status: 'degraded',
      detail: 'No encryption key material — set LEGAL_SECRETS_KEY (or LEGAL_SESSION_SECRET).',
    });
  } else {
    const plain = plaintextSecretCount();
    rows.push(
      plain > 0
        ? { name: 'Secrets at rest', status: 'degraded', detail: `${plain} secret(s) still stored in plaintext.` }
        : { name: 'Secrets at rest', status: 'ok', detail: 'AES-256-GCM encryption active.' },
    );
  }

  // AI (ChatGPT subscription, API-key fallback)
  if (await aiConfigured()) {
    const token = await loadCodexToken().catch(() => null);
    const via = token?.access ? `ChatGPT (${token.email || 'connected'})` : 'OpenAI API key';
    rows.push({ name: 'AI', status: 'ok', detail: `${via} — model ${selectedModel()}.` });
  } else {
    rows.push({
      name: 'AI',
      status: 'not_configured',
      detail: 'No ChatGPT connection and no API key. Connect in Settings; analyses are unavailable until then.',
    });
  }

  // Microsoft 365 / OneDrive library
  if (!isGraphConfigured()) {
    rows.push({
      name: 'Microsoft 365',
      status: 'not_configured',
      detail: 'Add the app registration (tenant, client id, secret) in Settings.',
    });
  } else if (!isGraphConnected()) {
    rows.push({
      name: 'Microsoft 365',
      status: 'not_configured',
      detail: 'App registration saved — sign in with the Microsoft account in Settings.',
    });
  } else if (!isLibraryConfigured()) {
    rows.push({
      name: 'Microsoft 365',
      status: 'not_configured',
      detail: 'Account connected — pick the library folder in Settings.',
    });
  } else {
    const sync = lastSync();
    const account = String(getSetting('graph.account_email') || 'connected');
    const folder = String(getSetting('graph.library_folder_name') || '');
    const syncedDetail = sync.at ? ` Last sync ${new Date(sync.at).toISOString()}.` : ' Never synced yet.';
    rows.push(
      sync.status && sync.status !== 'ok'
        ? { name: 'Microsoft 365', status: 'degraded', detail: `Last sync failed: ${sync.status}` }
        : { name: 'Microsoft 365', status: 'ok', detail: `${account} — library "${folder}".${syncedDetail}` },
    );
  }

  // Fake Graph is a TEST harness. If it is ever on in a real deployment the documents the
  // client receives are synthetic — the one failure mode §17 could not tolerate — so it is
  // reported loudly rather than left to be discovered by opening a PDF.
  if (process.env.LEGAL_FAKE_GRAPH === '1') {
    rows.push({
      name: 'Armazenamento simulado',
      status: 'degraded',
      detail:
        'LEGAL_FAKE_GRAPH=1: os PDFs e os envios para o OneDrive são SIMULADOS. Só deve estar ligado em testes.',
    });
  }

  const worst: HealthStatus = rows.some((row) => row.status === 'degraded') ? 'degraded' : 'ok';
  return { status: worst, rows };
}
