import { SettingsView } from '@/components/settings/settings-view';
import { requirePageSession } from '@/lib/server/page-auth';

export default async function SettingsPage() {
  const session = await requirePageSession({ next: '/settings' });
  return <SettingsView userName={session.name} />;
}
