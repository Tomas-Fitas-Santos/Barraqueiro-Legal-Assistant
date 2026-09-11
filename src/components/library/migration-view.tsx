'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

type MigrationItem = {
  kind: 'folder' | 'file';
  id: string;
  name: string;
  from: string;
  to: string;
  documents: number;
  conflict: boolean;
};

type Outcome = {
  id: string;
  name: string;
  status: 'moved' | 'failed' | 'skipped';
  detail: string;
  documents: number;
};

type Payload = {
  ok: boolean;
  state: 'pending' | 'partial' | 'done';
  configured: boolean;
  items: MigrationItem[];
  moved: number;
  failed: number;
  skipped: number;
  results?: Outcome[];
  error?: string;
};

const STATUS_LABEL: Record<Outcome['status'], string> = {
  moved: 'Movido',
  failed: 'Falhou',
  skipped: 'Ignorado',
};

export function MigrationView() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [results, setResults] = useState<Outcome[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const data = (await fetch('/api/library/migration').then((r) => r.json())) as Payload;
    setPayload(data);
    // Everything that can move is pre-selected; a conflict cannot, so it never is.
    setSelected(data.items?.filter((item) => !item.conflict).map((item) => item.id) || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const items = payload?.items || [];
  const movable = items.filter((item) => !item.conflict);
  const chosen = selected.filter((id) => movable.some((item) => item.id === id));

  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  async function run() {
    setBusy(true);
    setNotice('');
    const data = (await fetch('/api/library/migration', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: chosen }),
    }).then((r) => r.json())) as Payload;
    if (!data.ok) {
      setNotice(data.error || 'A migração falhou.');
      setBusy(false);
      return;
    }
    setResults(data.results || []);
    setPayload(data);
    setSelected(data.items?.filter((item) => !item.conflict).map((item) => item.id) || []);
    const moved = (data.results || []).filter((r) => r.status === 'moved').length;
    const failed = (data.results || []).filter((r) => r.status !== 'moved').length;
    setNotice(
      failed === 0
        ? `${moved} item(s) movido(s).`
        : `${moved} item(s) movido(s), ${failed} por resolver — ver abaixo.`,
    );
    setBusy(false);
  }

  if (loading) return <p className="ui-text-muted">A carregar…</p>;

  return (
    <div>
      <h1 className="m-0 mb-4 font-heading text-lg font-semibold text-ink0">
        Arrumar a biblioteca
      </h1>

      <div className="ui-soft-panel mb-3 grid gap-1 rounded-lg px-3 py-2 text-sm">
        <p className="m-0 ui-text-muted">
          Os documentos que já existiam antes da reorganização ficaram na raiz da biblioteca.
          Esta página move-os para <strong>1. Documentos oficiais Barraqueiro</strong>, de uma vez.
        </p>
        <p className="m-0 ui-text-subtle">
          Cada pasta é movida inteira, numa só operação, e os ficheiros mantêm a identidade que
          já tinham no OneDrive — nada é reprocessado e nenhuma citação existente deixa de
          funcionar.
        </p>
        {!payload?.configured && (
          <p className="m-0 ui-text-subtle">
            Sem ligação ao OneDrive: a arrumação é feita apenas nesta aplicação.
          </p>
        )}
      </div>

      {notice && <p className="mb-3 mt-0 text-base ui-text-muted">{notice}</p>}

      {items.length === 0 ? (
        <div className="ui-soft-panel rounded-lg px-3 py-4">
          <p className="m-0 text-base font-medium text-ink0">Não há nada por arrumar.</p>
          <p className="mb-0 mt-1 ui-text-subtle">
            Toda a biblioteca já está dentro das pastas da aplicação.
          </p>
          <p className="mt-3">
            <Link className="ui-btn-secondary rounded-md px-3.5 py-2 text-base" href="/library">
              Voltar à biblioteca
            </Link>
          </p>
        </div>
      ) : (
        <>
          <div className="ui-soft-panel mb-3 flex flex-wrap items-center gap-2 rounded-lg px-3 py-2">
            <span className="ui-text-muted">
              {items.length} item(s) por mover{chosen.length ? `, ${chosen.length} selecionado(s)` : ''}
            </span>
            <span className="ml-auto flex flex-wrap gap-2">
              <button
                className="ui-btn-secondary rounded-md px-3 py-1 text-sm"
                onClick={() => setSelected(movable.map((item) => item.id))}
                type="button"
              >
                Selecionar tudo
              </button>
              <button
                className="ui-btn-secondary rounded-md px-3 py-1 text-sm"
                onClick={() => setSelected([])}
                type="button"
              >
                Limpar
              </button>
              <button
                className="ui-btn-primary rounded-md px-4 py-1.5 text-base disabled:opacity-50"
                disabled={busy || chosen.length === 0}
                onClick={() => void run()}
                type="button"
              >
                {busy ? 'A mover…' : `Mover ${chosen.length} item(s)`}
              </button>
            </span>
          </div>

          <table className="w-full text-base">
            <thead>
              <tr className="ui-text-subtle text-left text-sm">
                <th className="w-8 py-1" />
                <th className="py-1">Nome</th>
                <th className="py-1">De</th>
                <th className="py-1">Para</th>
                <th className="py-1">Documentos</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-t border-line0">
                  <td className="py-2">
                    <input
                      checked={selected.includes(item.id)}
                      disabled={item.conflict}
                      onChange={() => toggle(item.id)}
                      type="checkbox"
                    />
                  </td>
                  <td className="py-2">
                    <span className="font-medium text-ink0">
                      {item.kind === 'folder' ? '📁' : '📄'} {item.name}
                    </span>
                    {item.conflict && (
                      <span className="ui-text-subtle block text-sm">
                        Já existe um item com este nome no destino — resolva no OneDrive antes de
                        arrumar este.
                      </span>
                    )}
                  </td>
                  <td className="py-2 ui-text-muted">{item.from || 'Raiz da biblioteca'}</td>
                  <td className="py-2 ui-text-muted">{item.to}</td>
                  <td className="py-2 ui-text-muted">{item.documents}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {results.length > 0 && (
        <div className="mt-5">
          <h2 className="m-0 mb-2 font-heading text-base font-semibold text-ink0">Resultado</h2>
          <ul className="m-0 grid gap-1 pl-4 text-sm">
            {results.map((result) => (
              <li key={result.id} className="ui-text-muted">
                <span className="font-medium text-ink0">{STATUS_LABEL[result.status]}</span> —{' '}
                {result.name}
                {result.detail ? `: ${result.detail}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
