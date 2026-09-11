import { HelpView } from '@/components/help/help-view';
import { requirePageSession } from '@/lib/server/page-auth';

export default async function HelpPage({
  searchParams,
}: {
  searchParams: Promise<{ context?: string; returnTo?: string }>;
}) {
  await requirePageSession({ next: '/ajuda' });
  const query = await searchParams;
  return <HelpView context={query.context || ''} returnTo={query.returnTo || ''} />;
}
