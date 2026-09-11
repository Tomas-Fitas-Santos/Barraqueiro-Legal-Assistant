'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { TopNav } from '@/components/app/top-nav';
import { HelpProvider } from '@/components/help/help-provider';
import { PreviewProvider } from '@/components/library/preview-context';

export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const tutorialWorkspace = /^\/tutoriais\/(library|summary|revision)$/.test(pathname);

  if (pathname === '/login') {
    return (
      <div className="fixed inset-0 mx-auto flex w-full max-w-[1760px] items-center justify-center overflow-y-auto px-6 py-10">
        <main className="w-full">{children}</main>
      </div>
    );
  }

  // The preview drawer is mounted once, here, so the Library list, the document detail page
  // and the wizard's picker all open the same one — and only ever one at a time.

  // App shell: the window never scrolls. The nav is fixed, and everything below is one
  // flexible area whose CONTAINERS scroll on their own (chat, tables, side panel…).
  return (
    <PreviewProvider>
      <HelpProvider>
        <div className="fixed inset-0 mx-auto flex w-full max-w-[1760px] flex-col gap-4 overflow-clip px-6 pb-5 pt-4">
          {!tutorialWorkspace ? <div className="shrink-0"><TopNav /></div> : null}
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
        </div>
      </HelpProvider>
    </PreviewProvider>
  );
}
