import { cookies, headers } from 'next/headers';

import { decodeBase64Url, encodeBase64Url, hmacSign, safeEqual, verifyPassword } from '@/lib/server/crypto';
import { getDb } from '@/lib/server/db';
import type { Role, SessionInfo } from '@/lib/types';

// One HMAC-signed cookie session (Naten pattern: payload = base64url(JSON) `.` HMAC-SHA256,
// exp in payload, timingSafeEqual verify). The DB row is authoritative on every read — the
// cookie only proves who signed in, not what they may do now.

export const SESSION_COOKIE = '__legal_session';

const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h

const SESSION_SECRET = process.env.LEGAL_SESSION_SECRET?.trim() || '';

// Whether the session cookie gets the Secure flag. LEGAL_SECURE_COOKIES, when set to an
// explicit on/off value, always wins; otherwise auto-detect from X-Forwarded-Proto (the
// edge proxy sets it in prod, so a fresh TLS deploy gets Secure cookies with no env var,
// while plain-HTTP local dev stays non-Secure).
function resolveSecureCookies(forwardedProto: string): boolean {
  const explicit = String(process.env.LEGAL_SECURE_COOKIES || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(explicit)) return true;
  if (['0', 'false', 'no', 'off'].includes(explicit)) return false;
  return String(forwardedProto || '').split(',')[0].trim().toLowerCase() === 'https';
}

export class LegalAuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type SessionPayload = { sub: string; role: Role; exp: number };

type UserRow = {
  user_id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  enabled: number;
};

function signSession(payload: SessionPayload, secret: string): string {
  const encoded = encodeBase64Url(JSON.stringify(payload));
  return `${encoded}.${hmacSign(encoded, secret)}`;
}

function verifySession(value: string, secret: string, nowMs = Date.now()): SessionPayload | null {
  if (!value) return null;
  const [encoded, signature] = value.split('.');
  if (!encoded || !signature || !safeEqual(signature, hmacSign(encoded, secret))) return null;
  try {
    const payload = JSON.parse(decodeBase64Url(encoded)) as SessionPayload;
    if (Number(payload.exp || 0) <= Math.floor(nowMs / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function readUser(userId: string): UserRow | null {
  return (getDb()
    .prepare('SELECT user_id, email, name, role, password_hash, enabled FROM users WHERE user_id = ? LIMIT 1')
    .get(userId) as UserRow | undefined) || null;
}

function sessionFromUser(user: UserRow): SessionInfo {
  return { userId: user.user_id, role: user.role, name: user.name, email: user.email };
}

export async function login(email: string, password: string): Promise<SessionInfo> {
  if (!SESSION_SECRET) throw new LegalAuthError('LEGAL_SESSION_SECRET is not configured.', 500);
  const normalized = String(email || '').trim().toLowerCase();
  const user = (getDb()
    .prepare('SELECT user_id, email, name, role, password_hash, enabled FROM users WHERE email = ? LIMIT 1')
    .get(normalized) as UserRow | undefined) || null;

  if (!user || !user.enabled || !verifyPassword(password, user.password_hash)) {
    throw new LegalAuthError('Invalid email or password.', 401);
  }

  getDb().prepare('UPDATE users SET last_login_at = ? WHERE user_id = ?').run(Date.now(), user.user_id);

  const cookieStore = await cookies();
  const secure = resolveSecureCookies((await headers()).get('x-forwarded-proto') || '');
  const payload: SessionPayload = {
    sub: user.user_id,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  cookieStore.set(SESSION_COOKIE, signSession(payload, SESSION_SECRET), {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
  return sessionFromUser(user);
}

export async function logout(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

export async function getSession(): Promise<SessionInfo | null> {
  // cookies() FIRST, before any short-circuit: reading the request cookies is what marks
  // every calling page dynamic. When the secret check came first, a build without env
  // (CI image builds have no .env) saw no dynamic API on the home page and PRERENDERED
  // it as a baked redirect to /login — sessions then appeared to "not stick" in prod.
  const cookieStore = await cookies();
  if (!SESSION_SECRET) return null;
  const cookie = cookieStore.get(SESSION_COOKIE)?.value || '';
  if (!cookie) return null;
  const payload = verifySession(cookie, SESSION_SECRET);
  if (!payload) return null;
  const user = readUser(payload.sub);
  // The DB is authoritative — a disabled user's live cookie stops working here.
  if (!user || !user.enabled) return null;
  return sessionFromUser(user);
}

export async function requireSession(): Promise<SessionInfo> {
  const session = await getSession();
  if (!session) throw new LegalAuthError('Authentication required.', 401);
  return session;
}
