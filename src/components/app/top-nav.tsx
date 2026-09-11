'use client';

import type { Route } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

import { ThemeToggle } from '@/components/app/theme-toggle';

export const NAV_ITEMS = [
  { href: '/', label: 'Início' },
  { href: '/library', label: 'Biblioteca' },
  { href: '/tutoriais', label: 'Tutoriais' },
  { href: '/settings', label: 'Definições' },
  { href: '/ajuda', label: 'Ajuda' },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function TopNavView({ activePath, onNavigate, onSignOut }: { activePath: string; onNavigate?: (href: string) => void; onSignOut?: () => void }) {
  const navItem = (item: typeof NAV_ITEMS[number]) => {
    const classes = `rounded-md px-3.5 py-1.5 text-base no-underline ${isActive(activePath, item.href) ? 'bg-accent-soft font-medium text-accent-strong' : 'bg-transparent text-ink1 hover:bg-surface-soft'}`;
    return onNavigate ? <button key={item.href} type="button" onClick={() => onNavigate(item.href)} data-tutorial-target={item.href === '/library' ? 'nav-library' : undefined} className={`${classes} border-0`}>{item.label}</button> : <Link key={item.href} href={item.href as Route} className={classes}>{item.label}</Link>;
  };
  const brand = <><span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-white p-1 ring-1 ring-line0"><Image src="/barraqueiro-mark.png" alt="Grupo Barraqueiro" width={256} height={212} priority className="h-full w-full object-contain" /></span><span className="font-heading text-lg font-semibold">Assistente Jurídico</span></>;

  return <header className="ui-panel flex items-center justify-between gap-4 rounded-xl px-5 py-3"><div className="flex items-center gap-6">{onNavigate ? <button type="button" onClick={() => onNavigate('/')} className="flex items-center gap-2.5 border-0 bg-transparent p-0 text-ink0">{brand}</button> : <Link href="/" className="flex items-center gap-2.5 text-ink0 no-underline">{brand}</Link>}<nav className="flex items-center gap-1.5">{NAV_ITEMS.map(navItem)}</nav></div><div className="flex items-center gap-2.5"><ThemeToggle /><button type="button" onClick={onSignOut} className="ui-btn-secondary rounded-md px-3.5 py-1.5 text-base">Sair</button></div></header>;
}

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  async function signOut() { await fetch('/api/auth/logout', { method: 'POST' }); router.push('/login'); router.refresh(); }
  return <TopNavView activePath={pathname} onSignOut={signOut} />;
}
