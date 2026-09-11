import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { getDb, getSetting, setSetting } from '@/lib/server/db';

// Encryption at rest for the secrets kept in the `settings` table: the ChatGPT OAuth token
// and, from phase 1 on, the Microsoft Graph refresh token. Same scheme as the other Naten
// apps (AES-256-GCM, HKDF-derived key), with the same design constraints:
//
//  * **Existing rows must keep working.** Reads accept both forms — an `enc:v1:` value is
//    decrypted, anything else is returned as-is (legacy plaintext).
//  * **Writes always encrypt**, so a value can only ever get safer, never revert.
//  * **Empty means unset, and stays empty.** Encrypting '' would produce a non-empty blob,
//    and every `configured` check in the app tests for a non-empty string.

const PREFIX = 'enc:v1:';

// Every settings key holding a credential. Grows with the phases (Graph tokens land here).
export const SECRET_SETTING_KEYS = [
  'ai.codex_token',
  'graph.refresh_token',
  'graph.client_secret',
] as const;

/**
 * Key material for the encryption key. `LEGAL_SECRETS_KEY` is the dedicated knob; falling
 * back to the session secret is deliberate — it is already required for the app to serve a
 * single authenticated request, so a real deployment always has key material. The HKDF
 * `info` label keeps the derived key cryptographically separate from the cookie-signing key.
 */
function encryptionKey(): Buffer | null {
  const explicit = String(process.env.LEGAL_SECRETS_KEY || '').trim();
  const fallback = String(process.env.LEGAL_SESSION_SECRET || '').trim();
  const material = explicit || fallback;
  if (!material) return null;
  const info = explicit ? 'legal-secrets-v1' : 'legal-secrets-from-session-v1';
  return Buffer.from(hkdfSync('sha256', Buffer.from(material, 'utf8'), Buffer.alloc(0), Buffer.from(info, 'utf8'), 32));
}

export function isSecretsEncryptionAvailable(): boolean {
  return encryptionKey() !== null;
}

export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

const b64 = (buf: Buffer) => buf.toString('base64url');

export function encryptSecret(plaintext: string): string {
  // Unset stays unset — load-bearing for every `configured` check.
  if (!plaintext) return '';
  if (isEncrypted(plaintext)) return plaintext; // already sealed; never double-wrap
  const key = encryptionKey();
  if (!key) {
    throw new Error(
      'Cannot store a secret: set LEGAL_SECRETS_KEY (or LEGAL_SESSION_SECRET) to enable encryption at rest.',
    );
  }
  const iv = randomBytes(12); // 96-bit nonce, the GCM standard; fresh per write
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${PREFIX}${b64(iv)}:${b64(cipher.getAuthTag())}:${b64(ct)}`;
}

/**
 * Returns plaintext for both forms. An encrypted value that cannot be decrypted returns ''
 * rather than throwing: that happens when the key material changed, and the honest reading
 * is "this credential is no longer available" — which callers handle as unconfigured.
 */
export function decryptSecret(stored: string): string {
  if (!stored) return '';
  if (!isEncrypted(stored)) return stored;
  const key = encryptionKey();
  if (!key) return '';
  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return '';
  try {
    const [ivPart, tagPart, ctPart] = parts;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctPart, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key or tampered ciphertext — GCM authentication failing is the point of using it.
    return '';
  }
}

/** Read a secret setting, transparently handling encrypted and legacy-plaintext rows. */
export function getSecretSetting(key: string): string {
  return decryptSecret(String(getSetting(key) || ''));
}

/** Write a secret setting, always encrypted. An empty value clears it. */
export function setSecretSetting(key: string, value: string): void {
  const plain = String(value || '').trim();
  setSetting(key, plain ? encryptSecret(plain) : '');
}

/**
 * One-time upgrade of rows written before encryption existed (or by an older build). Runs
 * at boot after the schema is ready. Best-effort: a deployment with no key material keeps
 * running on its plaintext rows (and says so in system health) rather than failing to start.
 */
export function migrateEncryptSecrets(): void {
  if (!isSecretsEncryptionAvailable()) return;
  let upgraded = 0;
  for (const key of SECRET_SETTING_KEYS) {
    const stored = String(getSetting(key) || '');
    if (!stored || isEncrypted(stored)) continue;
    try {
      setSetting(key, encryptSecret(stored));
      upgraded += 1;
    } catch (error) {
      console.warn(`[legal] Could not encrypt secret "${key}":`, error);
    }
  }
  if (!upgraded) return;

  // Encrypting the row is not enough: SQLite leaves the old value on freed pages (and in
  // the WAL), so the plaintext stays byte-readable in the file this exists to protect.
  // Checkpoint + VACUUM rewrites the file without the stale pages.
  try {
    getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
    getDb().exec('VACUUM');
    console.info(`[legal] Encrypted ${upgraded} stored secret(s) at rest and reclaimed the old pages.`);
  } catch (error) {
    console.warn(
      `[legal] Encrypted ${upgraded} secret(s), but VACUUM failed — old plaintext may remain in the database file:`,
      error,
    );
  }
}

/** How many secrets are still stored in the clear — surfaced in system health. */
export function plaintextSecretCount(): number {
  let n = 0;
  for (const key of SECRET_SETTING_KEYS) {
    const stored = String(getSetting(key) || '');
    if (stored && !isEncrypted(stored)) n += 1;
  }
  return n;
}
