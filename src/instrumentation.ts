// Next.js runs this once when the server process starts. Boots the optional periodic
// library sync — a no-op unless LEGAL_SYNC_INTERVAL_MINUTES is set AND the library is
// configured, so dev/CI and fresh installs run clean without it.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const minutes = Number(process.env.LEGAL_SYNC_INTERVAL_MINUTES || '0');
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  const { syncLibraryInBackground } = await import('@/lib/server/repo/library');
  setInterval(() => syncLibraryInBackground('interval'), minutes * 60_000).unref();
  console.info(`[legal] Library sync every ${minutes} min.`);
}
