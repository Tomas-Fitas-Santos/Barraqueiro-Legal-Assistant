import crypto from 'node:crypto';

// Password hashing (scrypt scheme, same as the other Naten apps)
// and HMAC cookie-session primitives. Shared by auth.ts and DB bootstrap seeding.

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('base64url');
  const key = crypto.scryptSync(password, salt, 64).toString('base64url');
  return `scrypt:${salt}:${key}`;
}

function parseScryptHash(value: string): { salt: string; key: string } | null {
  const parts = value.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt' || !parts[1] || !parts[2]) return null;
  return { salt: parts[1], key: parts[2] };
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function verifyPassword(candidate: string, storedHash: string): boolean {
  if (!candidate || !storedHash) return false;
  const scrypt = parseScryptHash(storedHash.trim());
  if (!scrypt) return false;
  const derived = crypto.scryptSync(candidate, scrypt.salt, 64).toString('base64url');
  return safeEqual(derived, scrypt.key);
}

/**
 * A bearer token and the value stored for it.
 *
 * Deliberately SHA-256 and not scrypt, which would be wrong twice over: the token is 256 bits of
 * `randomBytes`, so there is no dictionary to run against it, and the hash is computed on every
 * single API request a watcher makes — a deliberately slow KDF would turn each poll into ~100ms of
 * CPU. Password hashing is slow because passwords are guessable; this value is not.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** `hwt_` + 43 base64url chars. The scheme prefix makes a leaked token recognisable in a log. */
export function generateWatcherToken(): string {
  return `hwt_${crypto.randomBytes(32).toString('base64url')}`;
}

export function encodeBase64Url(input: string | Buffer): string {
  return typeof input === 'string' ? Buffer.from(input).toString('base64url') : input.toString('base64url');
}

export function decodeBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

export function hmacSign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function genId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

export function safeFilename(name: string): string {
  const base = String(name || 'file').replace(/[/\\]/g, '_').replace(/[^A-Za-z0-9._-]/g, '_');
  return base.slice(0, 180) || 'file';
}
