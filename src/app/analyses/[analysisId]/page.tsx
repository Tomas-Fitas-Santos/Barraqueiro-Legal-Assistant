import { notFound } from 'next/navigation';

import { AnalysisChatView } from '@/components/analyses/analysis-chat-view';
import { requirePageSession } from '@/lib/server/page-auth';
import { getAnalysis } from '@/lib/server/repo/analyses';

export default async function AnalysisPage({ params }: { params: Promise<{ analysisId: string }> }) {
  const { analysisId } = await params;
  await requirePageSession({ next: `/analyses/${analysisId}` });
  const analysis = getAnalysis(analysisId);
  if (!analysis || analysis.state === 'eliminada') notFound();
  return <AnalysisChatView analysisId={analysisId} />;
}
