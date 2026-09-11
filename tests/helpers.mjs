import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Boots the real built app against a throwaway LEGAL_DATA_DIR and drives it over HTTP, so
// tests exercise the actual auth, SQL and degradation paths (not mocks).

export const ADMIN_EMAIL = 'admin@test.local';
export const ADMIN_PW = 'testadminpw123';

export let BASE = '';
let proc = null;
let dataDir = '';

// The running server's throwaway data dir — lets a test reach the SQLite file directly for
// setups the HTTP API refuses by design.
export function testDataDir() {
  return dataDir;
}

async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export async function startServer({ seedDataDir, env: envOverride } = {}) {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'legal-test-'));
  if (seedDataDir) await seedDataDir(dataDir);
  // Ask the OS for a free port rather than guessing one. A random pick out of 400 slots
  // collides often enough with a dozen suites running that a test would occasionally talk
  // to ANOTHER suite's server — which surfaces as "invalid email or password", because the
  // admin it seeded belongs to a different data dir.
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const nextBin = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');

  // Explicitly set every LEGAL_* var so the dev .env (loaded by Next) can't leak in — Next's
  // @next/env never overrides values already present in process.env. AI must look
  // UNCONFIGURED here: the suite asserts the graceful "not configured" paths, and a real
  // key in a developer's .env would otherwise cause failures CI never sees.
  const env = {
    ...process.env,
    LEGAL_DATA_DIR: dataDir,
    LEGAL_SESSION_SECRET: 'a'.repeat(48),
    LEGAL_SECRETS_KEY: '',
    LEGAL_BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL,
    LEGAL_BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PW,
    LEGAL_SECURE_COOKIES: '0',
    LEGAL_PUBLIC_BASE_URL: BASE,
    LEGAL_OPENAI_API_KEY: '',
    LEGAL_FAKE_GRAPH: '1',
    LEGAL_MAX_UPLOAD_MB: '1',
    // NOT throwaway: the encoder's weights are a 120 MB download, and a per-suite data dir
    // would fetch them again for every suite that ingests anything. The repo's own cache is
    // shared, and a checkout that has never downloaded them still passes — the semantic
    // assertions report and stop rather than failing.
    LEGAL_MODELS_DIR: path.join(process.cwd(), 'data-home', 'models'),
    PORT: String(port),
    NODE_ENV: 'production',
    // A suite can boot the app with no OneDrive at all — the honest way to prove that a
    // format the app reads for itself needs nothing but the app.
    ...(envOverride || {}),
  };

  proc = spawn(process.execPath, [nextBin, 'start', '-p', String(port)], { env, stdio: 'ignore' });

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/login`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('legal-assistant server did not become ready in time');
}

export async function stopServer() {
  if (proc) {
    proc.kill('SIGTERM');
    proc = null;
  }
  if (dataDir) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

export function newJar() {
  return { cookies: new Map() };
}

// Minimal cookie jar over fetch: applies Set-Cookie, sends Cookie.
export async function api(path, opts = {}) {
  const { method = 'GET', body, jar } = opts;
  const headers = {};
  if (jar && jar.cookies.size) {
    headers.cookie = [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload, redirect: 'manual' });
  if (jar) {
    for (const setCookie of res.headers.getSetCookie?.() || []) {
      const [pair, ...attrs] = setCookie.split(';');
      const [name, ...valueParts] = pair.split('=');
      const value = valueParts.join('=');
      const expired = attrs.some((a) => a.trim().toLowerCase().startsWith('max-age=0'));
      if (expired || value === '') jar.cookies.delete(name.trim());
      else jar.cookies.set(name.trim(), value);
    }
  }
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data, text };
}

export async function loginAdmin() {
  const jar = newJar();
  const res = await api('/api/auth/login', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, password: ADMIN_PW },
    jar,
  });
  if (!res.data?.ok) throw new Error(`admin login failed: ${res.text}`);
  return jar;
}

// Import a TypeScript module from the real source tree, transpiled on the fly with the
// repo's own `typescript` package, so unit tests exercise exactly what the app ships (this
// box's Node build lacks --experimental-strip-types, so a direct .ts import is not
// available). `@/…` imports are followed and transpiled too, flattened into one temp dir —
// which is what lets a module like src/lib/workflow/* be unit-tested even though it imports
// @/lib/types. Only source-tree modules are followed; bare package specifiers are left as
// they are, so a module reaching for node_modules still resolves normally.
export async function loadTsModule(relPath) {
  const { default: ts } = await import('typescript');
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'legal-tsmod-'));
  const flatName = (rel) => `${rel.replace(/^src\//, '').replace(/\.ts$/, '').replace(/[\/]/g, '__')}.mjs`;
  const emitted = new Set();

  const emit = (rel) => {
    if (emitted.has(rel)) return;
    emitted.add(rel);
    const source = readFileSync(path.join(process.cwd(), rel), 'utf8');
    const deps = [];
    // Rewrite '@/x/y' → './x__y.mjs' and queue the dependency for its own transpile.
    const rewritten = source.replace(/(from\s+|import\s*\()(['"])@\/([^'"]+)\2/g, (_m, head, quote, spec) => {
      const depRel = ['src/', spec, '.ts'].join('');
      const indexRel = `src/${spec}/index.ts`;
      const target = existsSync(path.join(process.cwd(), depRel)) ? depRel : indexRel;
      deps.push(target);
      return `${head}${quote}./${flatName(target)}${quote}`;
    });
    const js = ts.transpileModule(rewritten, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    writeFileSync(path.join(outDir, flatName(rel)), js);
    for (const dep of deps) emit(dep);
  };

  emit(relPath);
  return import(pathToFileURL(path.join(outDir, flatName(relPath))).href);
}

/**
 * Seed the extraction header that seeded items belong to. Items are stored per EXTRACTION
 * (an immutable artifact, like a document version), so a test that inserts analysis_items
 * has to create the row they hang from — exactly as a real run does.
 */
export function seedExtraction(d, analysisId, extractionId, options = {}) {
  const now = Date.now();
  d.prepare(
    `INSERT INTO analysis_extractions
       (extraction_id, analysis_id, path_letter, seq, origin, accepted_count, rejected_count, approved_at, created_at)
     VALUES (?, ?, ?, ?, 'agent', 0, 0, ?, ?)`,
  ).run(extractionId, analysisId, options.path || 'a', options.seq || 1, options.approvedAt ?? null, now);
  return extractionId;
}

/** Recompute an extraction's counts after a test has inserted its items. */
export function countExtraction(d, extractionId) {
  d.prepare(
    `UPDATE analysis_extractions SET
       accepted_count = (SELECT COALESCE(SUM(accepted), 0) FROM analysis_items WHERE extraction_id = ?),
       rejected_count = (SELECT COUNT(*) - COALESCE(SUM(accepted), 0) FROM analysis_items WHERE extraction_id = ?)
     WHERE extraction_id = ?`,
  ).run(extractionId, extractionId, extractionId);
}

/**
 * Wait for a conversion to reach a settled state. Approving the document returns as soon
 * as the chain is under way, so a test that asserts on the finished PDF has to wait for
 * the same thing the UI waits for: the conversion's own state.
 */
export async function settledConversion(analysisId, conversionId, jar, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await api(`/api/analyses/${analysisId}/conversions`, { jar });
    const conversion = (res.data.conversions || []).find((c) => c.conversionId === conversionId);
    if (conversion && !['pendente', 'em_conversao'].includes(conversion.state)) return conversion;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`conversion ${conversionId} did not settle in ${timeoutMs}ms`);
}
