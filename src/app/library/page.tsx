import { Suspense } from 'react';

import { LibraryView } from '@/components/library/library-view';
import { requirePageSession } from '@/lib/server/page-auth';

export default async function LibraryPage() {
  await requirePageSession({ next: '/library' });
  // useSearchParams() needs a suspense boundary: the whole view's state (folder, sort,
  // filter, selection) lives in the URL so that back, refresh and links all work.
  return (
    <Suspense fallback={null}>
      <LibraryView />
    </Suspense>
  );
}
