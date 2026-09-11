'use client';

import { useCallback, useState } from 'react';

// Uploading several files, one at a time, with each one's fate visible.
//
// Sequential is not a limitation here — the ingest pipeline serialises through one queue
// anyway, so firing ten uploads in parallel would only pile them up behind each other while
// making the failure of any one of them harder to attribute.

export type UploadEntry = {
  name: string;
  status: 'pending' | 'uploading' | 'done' | 'error';
  detail: string;
};

export function useUploadQueue(options: { folder: string; onUploaded: () => void | Promise<void> }) {
  const [entries, setEntries] = useState<UploadEntry[]>([]);
  const [busy, setBusy] = useState(false);

  const update = (name: string, patch: Partial<UploadEntry>) =>
    setEntries((current) => current.map((entry) => (entry.name === name ? { ...entry, ...patch } : entry)));

  const upload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setEntries(files.map((file) => ({ name: file.name, status: 'pending', detail: '' })));
      setBusy(true);
      try {
        for (const file of files) {
          update(file.name, { status: 'uploading', detail: 'A carregar…' });
          try {
            const body = new FormData();
            body.append('file', file);
            body.append('folder', options.folder);
            const data = await fetch('/api/library/upload', { method: 'POST', body }).then((r) => r.json());
            if (!data.ok) {
              update(file.name, { status: 'error', detail: data.error || 'O carregamento falhou.' });
              continue;
            }
            update(file.name, {
              status: data.indexError ? 'error' : 'done',
              // A file that is stored but unreadable is not a failed upload — say which it is.
              detail: data.indexError ? `Guardado, mas sem texto: ${data.indexError}` : 'Processado.',
            });
          } catch {
            update(file.name, { status: 'error', detail: 'O carregamento falhou.' });
          }
        }
        await options.onUploaded();
      } finally {
        setBusy(false);
      }
    },
    [options],
  );

  return { entries, busy, upload, clear: () => setEntries([]) };
}
