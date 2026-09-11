'use client';

import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { PreviewDrawer, type PreviewTarget } from '@/components/library/preview-drawer';

// One drawer in the tree, reachable from anywhere.
//
// The Library list, the document detail page and the analysis wizard's picker all want to
// open a document. Without this each would own its own copy, they would drift, and two of
// them could be open at once.

type PreviewApi = {
  open: (target: PreviewTarget) => void;
  close: () => void;
  target: PreviewTarget | null;
};

const Ctx = createContext<PreviewApi | null>(null);

export function PreviewProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [target, setTarget] = useState<PreviewTarget | null>(null);

  const api = useMemo<PreviewApi>(
    () => ({ open: setTarget, close: () => setTarget(null), target }),
    [target],
  );

  const openDetail = useCallback(
    (documentId: string) => {
      setTarget(null);
      router.push(`/library/${documentId}`);
    },
    [router],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <PreviewDrawer
        target={target}
        onClose={() => setTarget(null)}
        // Not offered when it is the page behind the drawer: a button that goes where you
        // already are reads as broken.
        onOpenDetail={target && pathname === `/library/${target.documentId}` ? undefined : openDetail}
      />
    </Ctx.Provider>
  );
}

export function usePreview(): PreviewApi {
  const api = useContext(Ctx);
  // A no-op rather than a throw: a component that offers a preview should still render in a
  // context that has no drawer (a test, a future embed), just without opening one.
  return api || { open: () => {}, close: () => {}, target: null };
}
