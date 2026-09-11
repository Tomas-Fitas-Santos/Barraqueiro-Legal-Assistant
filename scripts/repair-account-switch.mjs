// One-off repair for the Barraqueiro install after the OneDrive account was switched
// (phase 0). Runs INSIDE the container: `node /tmp/repair.mjs [--apply]`.
//
// The account switch left every document row pointing at item ids on the previous
// account's drive. The bytes were never lost — the app stores every ingested document
// content-addressed under files/originals — so the repair uploads them into the new
// account's library and repoints the existing rows. Rows keep their document_id, so
// pages, segments, citations and analyses stay attached.
//
// Deliberately standalone: the container ships a built Next app, not the TypeScript
// sources, so the few things it needs from the app (secret decryption, the folder layout)
// are restated here rather than imported. Keep them in step with:
//   src/lib/server/secrets.ts, src/lib/library-layout.ts

import { createDecipheriv, createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const APPLY = process.argv.includes('--apply');
const DATA = process.env.LEGAL_DATA_DIR || '/data-home';
const db = new DatabaseSync(path.join(DATA, 'legal-assistant.sqlite'));

const GRAPH = 'https://graph.microsoft.com/v1.0';
const PREFIX = 'enc:v1:';
const LIBRARY_FOLDERS = {
  official: '1. Documentos oficiais Barraqueiro',
  templates: '2. Templates',
  generated: '3. Documentos gerados',
};
const ANALYSIS_FOLDER_NAMES = { summary: 'Resumo documental', revision: 'Revisão e Atualização' };
const LEGACY_GENERATED = 'Documentos gerados (Assistente Jurídico)';

const getSetting = (k) => {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  return r ? String(r.value) : '';
};
const setSetting = (k, v) =>
  db
    .prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
    .run(k, v, Date.now());

function encryptionKey() {
  const explicit = String(process.env.LEGAL_SECRETS_KEY || '').trim();
  const fallback = String(process.env.LEGAL_SESSION_SECRET || '').trim();
  const material = explicit || fallback;
  if (!material) return null;
  const info = explicit ? 'legal-secrets-v1' : 'legal-secrets-from-session-v1';
  return Buffer.from(hkdfSync('sha256', Buffer.from(material, 'utf8'), Buffer.alloc(0), Buffer.from(info, 'utf8'), 32));
}

function decryptSecret(stored) {
  if (!stored) return '';
  if (!stored.startsWith(PREFIX)) return stored;
  const key = encryptionKey();
  if (!key) return '';
  const [ivPart, tagPart, ctPart] = stored.slice(PREFIX.length).split(':');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctPart, 'base64url')), decipher.final()]).toString('utf8');
}

function encryptSecret(plaintext) {
  if (!plaintext) return '';
  const key = encryptionKey();
  if (!key) throw new Error('no key material');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const b64 = (b) => b.toString('base64url');
  return `${PREFIX}${b64(iv)}:${b64(cipher.getAuthTag())}:${b64(ct)}`;
}

// --- Graph -----------------------------------------------------------------

let accessToken = '';

async function signIn() {
  const tenant = getSetting('graph.tenant_id') || 'consumers';
  const body = new URLSearchParams({
    client_id: getSetting('graph.client_id'),
    client_secret: decryptSecret(getSetting('graph.client_secret')),
    grant_type: 'refresh_token',
    refresh_token: decryptSecret(getSetting('graph.refresh_token')),
    scope: 'offline_access User.Read Files.ReadWrite',
  });
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`sign-in failed: ${JSON.stringify(data).slice(0, 300)}`);
  accessToken = data.access_token;
  // Refresh tokens ROTATE. Persisting the replacement immediately is what stops this
  // script from logging the running app out of the client's OneDrive.
  if (data.refresh_token) {
    setSetting('graph.refresh_token', encryptSecret(data.refresh_token));
    console.log('  rotated refresh token persisted');
  }
}

async function graph(pathOrUrl, init = {}) {
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
  return fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${accessToken}` } });
}

const folderIdCache = new Map();

async function ensureFolderPath(relativePath) {
  const root = getSetting('graph.library_folder_id');
  let parentId = root;
  let accumulated = '';
  for (const segment of relativePath.split('/').filter(Boolean)) {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment;
    if (folderIdCache.has(accumulated)) {
      parentId = folderIdCache.get(accumulated);
      continue;
    }
    const res = await graph(`/me/drive/items/${encodeURIComponent(parentId)}/children`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: segment, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
    });
    let id;
    if (res.status === 409) {
      const existing = await graph(
        `/me/drive/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(segment)}?$select=id`,
      );
      if (!existing.ok) throw new Error(`cannot resolve existing folder ${accumulated}`);
      id = (await existing.json()).id;
    } else if (res.ok) {
      id = (await res.json()).id;
    } else {
      throw new Error(`folder ${accumulated} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    folderIdCache.set(accumulated, id);
    // The app caches these ids too; seeding them keeps its uploads off the slow path.
    setSetting(`graph.folder.${accumulated}`, id);
    parentId = id;
  }
  return parentId;
}

async function uploadFile(folderId, name, bytes, mime) {
  const res = await graph(
    `/me/drive/items/${encodeURIComponent(folderId)}:/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=replace`,
    { method: 'PUT', headers: { 'Content-Type': mime || 'application/octet-stream' }, body: new Uint8Array(bytes) },
  );
  if (!res.ok) throw new Error(`upload ${name} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// --- What needs repairing ---------------------------------------------------

/** Legacy output paths carry the analysis id in "(xxxxxx)" — that is what names the workflow. */
function canonicalPath(docPath) {
  if (docPath !== LEGACY_GENERATED && !docPath.startsWith(`${LEGACY_GENERATED}/`)) return docPath;
  const leaf = docPath.slice(LEGACY_GENERATED.length + 1);
  if (!leaf) return LIBRARY_FOLDERS.generated;
  const suffix = /\(([^)]+)\)\s*$/.exec(leaf)?.[1] || '';
  let type = '';
  if (suffix) {
    const row = db.prepare('SELECT type FROM analyses WHERE analysis_id LIKE ?').get(`%${suffix}`);
    if (row) type = row.type;
  }
  if (!type) type = /^revis/i.test(leaf) ? 'revision' : 'summary';
  return `${LIBRARY_FOLDERS.generated}/${ANALYSIS_FOLDER_NAMES[type]}/${leaf}`;
}

async function main() {
  const drive = getSetting('graph.drive_id');
  const root = getSetting('graph.library_folder_id');
  console.log(`account : ${getSetting('graph.account_email')}`);
  console.log(`drive   : ${drive}`);
  console.log(`library : ${getSetting('graph.library_folder_name')} [${root}]`);
  console.log(`mode    : ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const rows = db.prepare('SELECT * FROM documents WHERE removed = 0').all();
  const stranded = rows.filter(
    (r) => !String(r.drive_item_id).startsWith(drive) && !String(r.drive_item_id).startsWith('local-'),
  );

  const uploads = [];
  const retire = [];
  for (const doc of stranded) {
    const bytes = doc.sha256 ? path.join(DATA, 'files', 'originals', doc.sha256) : '';
    if (bytes && existsSync(bytes)) {
      uploads.push({ doc, file: bytes, target: canonicalPath(doc.path) });
      continue;
    }
    // No bytes: only the built-in templates are in this position, and the new account
    // already has its own row for each at the same path. Retiring the orphan is right —
    // republishing would put a second copy of the app's own stencil in the library.
    const twin = rows.find(
      (r) => r.document_id !== doc.document_id && r.name === doc.name && r.path === doc.path && String(r.drive_item_id).startsWith(drive),
    );
    retire.push({ doc, twin: twin ? twin.document_id : null });
  }

  console.log(`stranded: ${stranded.length}  ->  upload ${uploads.length}, retire ${retire.length}\n`);
  for (const u of uploads) {
    const moved = u.target !== u.doc.path;
    console.log(`  UPLOAD ${u.doc.name}`);
    console.log(`         ${u.doc.path || '(root)'}${moved ? `\n      -> ${u.target}` : ''}`);
  }
  for (const r of retire) {
    console.log(`  RETIRE ${r.doc.name}  (${r.doc.path})  twin=${r.twin || 'NONE — would leave no copy!'}`);
  }
  if (retire.some((r) => !r.twin)) throw new Error('refusing: a retire candidate has no replacement row');
  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply.');
    return;
  }

  console.log('\nsigning in...');
  await signIn();

  const now = Date.now();
  let done = 0;
  for (const u of uploads) {
    const folderId = await ensureFolderPath(u.target);
    const bytes = readFileSync(u.file);
    const item = await uploadFile(folderId, u.doc.name, bytes, u.doc.mime);
    db.prepare(
      `UPDATE documents SET drive_item_id = ?, path = ?, size = ?, etag = ?, ctag = ?, web_url = ?,
              drive_modified_at = ?, synced_at = ?, updated_at = ?
       WHERE document_id = ?`,
    ).run(
      item.id,
      u.target,
      bytes.length,
      String(item.eTag || ''),
      String(item.cTag || ''),
      String(item.webUrl || ''),
      Date.parse(item.lastModifiedDateTime || '') || now,
      now,
      now,
      u.doc.document_id,
    );
    done += 1;
    console.log(`  ok  ${u.doc.name} -> ${u.target}`);
  }

  for (const r of retire) {
    db.prepare('UPDATE documents SET removed = 1, updated_at = ? WHERE document_id = ?').run(now, r.doc.document_id);
    console.log(`  retired ${r.doc.name} (replaced by ${r.twin})`);
  }

  // The delta cursor described the library before these uploads; a full re-enumeration is
  // the only way the next sync agrees with what is now on the drive.
  setSetting('graph.delta_link', '');
  console.log(`\nuploaded ${done}, retired ${retire.length}, delta cursor reset.`);
}

main().catch((error) => {
  console.error('\nFAILED:', error.message);
  process.exit(1);
});
