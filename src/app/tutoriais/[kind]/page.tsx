import { notFound } from 'next/navigation';

import { TutorialWorkspace } from '@/components/tutorials/tutorial-workspace';
import { isTutorialKind } from '@/lib/tutorials';

export default async function TutorialPage({
  params,
  searchParams,
}: {
  params: Promise<{ kind: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const [{ kind }, query] = await Promise.all([params, searchParams]);
  if (!isTutorialKind(kind)) notFound();
  return <TutorialWorkspace kind={kind} initialRunId={query.run || ''} />;
}
