import { NewAnalysisWizard } from '@/components/analyses/new-analysis-wizard';
import { requirePageSession } from '@/lib/server/page-auth';

export default async function NewAnalysisPage() {
  await requirePageSession({ next: '/analyses/new' });
  return <NewAnalysisWizard />;
}
