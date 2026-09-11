import { redirect } from 'next/navigation';

import { getSession } from '@/lib/server/auth';
import type { SessionInfo } from '@/lib/types';

// Server-component guard: returns the session or redirects to /login. `next` is a relative
// path the login page returns the user to after signing in.
export async function requirePageSession(options?: { next?: string }): Promise<SessionInfo> {
  const session = await getSession();
  if (!session) redirect(options?.next ? `/login?next=${encodeURIComponent(options.next)}` : '/login');
  return session;
}
