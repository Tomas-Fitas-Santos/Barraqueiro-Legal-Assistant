import path from 'node:path';

// Own data-root resolver. Everything this app persists (SQLite DB + document cache) lives
// under LEGAL_DATA_DIR. Default: ./data-home locally, /data-home in-container (set by the
// Dockerfile). Pattern shared with the other Naten apps; namespace deliberately our own.
export const LEGAL_DATA_DIR: string = (() => {
  const configured = String(process.env.LEGAL_DATA_DIR || '').trim();
  if (configured) return path.resolve(configured);
  return path.join(process.cwd(), 'data-home');
})();

export const LEGAL_DB_PATH = path.join(LEGAL_DATA_DIR, 'legal-assistant.sqlite');
export const LEGAL_FILES_DIR = path.join(LEGAL_DATA_DIR, 'files');

/**
 * Where the local encoder's weights live. Under the data root, not node_modules: the image
 * bakes them in, but a volume-mounted install can hold them too, and either way they are
 * ~120 MB of content-addressed files that must survive a container rebuild.
 */
export function modelsDir(): string {
  return String(process.env.LEGAL_MODELS_DIR || '').trim() || path.join(LEGAL_DATA_DIR, 'models');
}

export function maxUploadBytes(): number {
  const mb = Number(process.env.LEGAL_MAX_UPLOAD_MB || '50');
  return (Number.isFinite(mb) && mb > 0 ? mb : 50) * 1024 * 1024;
}
