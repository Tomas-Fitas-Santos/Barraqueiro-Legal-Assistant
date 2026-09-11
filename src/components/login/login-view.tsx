'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { PasswordInput } from '@/components/ui/password-input';

export function LoginView() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        setError(data.error || 'Não foi possível entrar.');
        return;
      }
      router.push('/');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <div className="ui-panel rounded-xl p-8">
        <div className="mb-6 flex flex-col items-center gap-4 text-center">
          {/* A white safe area, so the mark reads the same in both themes. */}
          <span className="inline-flex items-center justify-center rounded-lg bg-white px-5 py-4 ring-1 ring-line0">
            <Image
              src="/barraqueiro-logo.png"
              alt="Grupo Barraqueiro"
              width={640}
              height={631}
              priority
              className="h-24 w-auto"
            />
          </span>
          <div>
            <h1 className="m-0 font-heading text-2xl font-semibold text-ink0">Assistente Jurídico</h1>
            <p className="mt-1.5 mb-0 text-base ui-text-muted">
              Produção controlada de documentos jurídicos para o Grupo Barraqueiro.
            </p>
          </div>
        </div>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <label htmlFor="email" className="text-base font-medium text-ink1">
              E-mail
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="ui-input rounded-md px-3.5 py-2.5"
            />
          </div>
          <div className="grid gap-2">
            <label htmlFor="password" className="text-base font-medium text-ink1">
              Palavra-passe
            </label>
            <PasswordInput
              id="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error ? <p className="m-0 text-base text-danger">{error}</p> : null}
          <button type="submit" disabled={busy} className="ui-btn-primary rounded-md px-4 py-2.5 text-base">
            {busy ? 'A entrar…' : 'Entrar'}
          </button>
        </form>
      </div>
    </div>
  );
}
