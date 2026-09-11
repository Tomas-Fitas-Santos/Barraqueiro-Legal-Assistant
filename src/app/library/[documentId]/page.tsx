import { notFound } from 'next/navigation';

import { DocumentDetailView } from '@/components/library/document-detail-view';
import { requirePageSession } from '@/lib/server/page-auth';
import { getDocumentDetail } from '@/lib/server/repo/library';

export default async function DocumentPage({ params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  await requirePageSession({ next: `/library/${documentId}` });
  const document = getDocumentDetail(documentId);
  if (!document) notFound();
  return <DocumentDetailView documentId={documentId} />;
}
