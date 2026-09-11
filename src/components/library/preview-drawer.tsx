'use client';

import { DocumentPreview } from '@/components/library/document-preview';
import type { ReactNode } from 'react';

import { SLIDE_OVER_FRAME_HEIGHT, SlideOver } from '@/components/ui/slide-over';

export type PreviewTarget = {
  documentId: string;
  name?: string;
  /** Open at a particular page — a citation, or a folder listing's "page N". */
  page?: number;
  /** Highlight this passage, which also selects the text view over the PDF. */
  excerpt?: string;
};

export function PreviewDrawer({
  target,
  onClose,
  onOpenDetail,
  content,
  downloadHref,
  modal = true,
  contained = false,
  tutorialTarget,
}: {
  target: PreviewTarget | null;
  onClose: () => void;
  onOpenDetail?: (documentId: string) => void;
  /** Isolated preview bytes can supply the same drawer without using the live document API. */
  content?: ReactNode;
  downloadHref?: string;
  modal?: boolean;
  contained?: boolean;
  tutorialTarget?: string;
}) {
  return (
    <SlideOver
      open={target !== null}
      onClose={onClose}
      modal={modal}
      contained={contained}
      tutorialTarget={tutorialTarget}
      title={target?.name || 'Documento'}
      actions={
        target ? (
          <>
            {onOpenDetail ? (
              <button
                type="button"
                onClick={() => onOpenDetail(target.documentId)}
                className="ui-btn-secondary rounded-md px-3 py-1 text-sm"
              >
                Abrir detalhe
              </button>
            ) : null}
            <a
              href={downloadHref || `/api/library/documents/${target.documentId}/download`}
              className="ui-btn-secondary rounded-md px-3 py-1 text-sm no-underline"
            >
              Descarregar
            </a>
          </>
        ) : null
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {target ? content || (
          <DocumentPreview documentId={target.documentId} page={target.page} excerpt={target.excerpt} showTitle={false} frameClassName={SLIDE_OVER_FRAME_HEIGHT} />
        ) : null}
      </div>
    </SlideOver>
  );
}
