'use client';

import { useCallback, useEffect, useState } from 'react';

// The only thing a library move asks the user. Everything else about moving — rebuilding the
// folder structure, dropping the caches, resetting the sync cursor — the app does silently,
// because none of it is a decision. This is: the documents are still in the previous
// location, and only the user knows whether they should be brought across.

type Move = {
  fromAccountEmail: string;
  fromFolderName: string;
  sameAccount: boolean;
  documentCount: number;
  transferableCount: number;
};

type Report = { transferred: number; stillMissing: number; failures: Array<{ name: string; reason: string }> };

export function LibraryMovePrompt({ onDone }: { onDone: () => void }) {
  const [move, setMove] = useState<Move | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  const [report, setReport] = useState<Report | null>(null);

  const load = useCallback(async () => {
    const data = await fetch('/api/library/transfer').then((r) => r.json());
    setMove(data.move ?? null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const data = await fetch('/api/library/transfer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (data.report) setReport(data.report as Report);
      await load();
      onDone();
    } finally {
      setBusy(false);
    }
  }

  if (report) {
    // One report for the whole transfer, however many files it touched.
    return (
      <div className="ui-soft-panel mb-3 grid gap-2 rounded-lg px-4 py-3 text-base">
        <p className="m-0 font-medium text-ink0">
          {report.transferred} documento(s) transferido(s) para a nova biblioteca.
        </p>
        {report.stillMissing > 0 ? (
          <p className="m-0 ui-text-muted">
            {report.stillMissing} continuam em falta — a aplicação não guarda cópia destes ficheiros e
            eles terão de ser colocados na biblioteca manualmente. As análises que dependem deles
            ficam arquivadas até lá.
          </p>
        ) : null}
        {report.failures.length > 0 ? (
          <div className="grid gap-1">
            <p className="m-0 ui-text-muted">Não foi possível transferir {report.failures.length}:</p>
            <ul className="m-0 grid gap-0.5 pl-5 text-sm ui-text-muted">
              {report.failures.map((failure) => (
                <li key={failure.name}>
                  <span className="text-ink0">{failure.name}</span> — {failure.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <button type="button" onClick={() => setReport(null)} className="ui-link justify-self-start text-sm">
          Fechar
        </button>
      </div>
    );
  }

  if (!move) return null;

  const where = move.sameAccount
    ? `na pasta “${move.fromFolderName}”`
    : `na conta ${move.fromAccountEmail || 'anterior'}`;
  const leftBehind = move.documentCount - move.transferableCount;

  return (
    <div className="ui-panel mb-3 grid gap-3 rounded-lg px-4 py-3">
      <div className="grid gap-1">
        <p className="m-0 text-base font-medium text-ink0">
          A biblioteca mudou. {move.documentCount} documento(s) continuam {where}.
        </p>
        <p className="m-0 text-base ui-text-muted">
          A aplicação pode copiá-los para a nova biblioteca a partir da cópia que guarda de cada
          ficheiro — sem voltar a aceder à localização anterior.
          {leftBehind > 0
            ? ` ${leftBehind} não têm cópia guardada e terão de ser colocados manualmente.`
            : ''}
        </p>
      </div>

      {confirmingSkip ? (
        <div className="grid gap-2">
          <p className="m-0 text-base text-ink0">
            Sem transferir, os {move.documentCount} documento(s) ficam apenas {where}. As análises
            que dependem deles ficam arquivadas até os ficheiros voltarem à biblioteca.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => decide({ decision: 'skip', confirmDocumentCount: move.documentCount })}
              className="ui-btn-danger rounded-md px-3.5 py-1.5 text-base disabled:opacity-50"
            >
              Deixar {move.documentCount} documento(s) para trás
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmingSkip(false)}
              className="ui-btn-secondary rounded-md px-3.5 py-1.5 text-base disabled:opacity-50"
            >
              Voltar atrás
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || move.transferableCount === 0}
            onClick={() => decide({ decision: 'transfer' })}
            className="ui-btn-primary rounded-md px-3.5 py-1.5 text-base disabled:opacity-50"
          >
            {busy ? 'A transferir…' : `Transferir ${move.transferableCount} documento(s)`}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmingSkip(true)}
            className="ui-btn-secondary rounded-md px-3.5 py-1.5 text-base disabled:opacity-50"
          >
            Não transferir
          </button>
        </div>
      )}
    </div>
  );
}
