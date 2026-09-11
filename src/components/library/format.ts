// Formatting shared by every Library surface, so a size or a date never renders two ways.

export function formatSize(bytes: number): string {
  if (!bytes) return '—';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** What OneDrive puts in the size column for a folder. */
export function formatItemCount(count: number): string {
  if (!count) return '—';
  return count === 1 ? '1 item' : `${count} itens`;
}

// Explicit locale: `toLocaleDateString()` with no argument renders differently for every
// visitor's browser, which is not what a Portuguese app wants.
const DATE = new Intl.DateTimeFormat('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric' });
const DATE_TIME = new Intl.DateTimeFormat('pt-PT', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDate(at: number): string {
  return at ? DATE.format(new Date(at)) : '—';
}

export function formatDateTime(at: number): string {
  return at ? DATE_TIME.format(new Date(at)) : '—';
}
