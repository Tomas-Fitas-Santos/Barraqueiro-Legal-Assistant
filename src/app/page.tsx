import { HomeView } from '@/components/home/home-view';
import { requirePageSession } from '@/lib/server/page-auth';

export default async function HomePage() {
  await requirePageSession({ next: '/' });
  return <HomeView />;
}
