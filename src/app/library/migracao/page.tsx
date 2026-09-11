import { MigrationView } from '@/components/library/migration-view';
import { requirePageSession } from '@/lib/server/page-auth';

export default async function LibraryMigrationPage() {
  await requirePageSession({ next: '/library/migracao' });
  return <MigrationView />;
}
