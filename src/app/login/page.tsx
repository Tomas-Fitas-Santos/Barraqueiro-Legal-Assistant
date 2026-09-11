import { redirect } from 'next/navigation';

import { LoginView } from '@/components/login/login-view';
import { getSession } from '@/lib/server/auth';

export default async function LoginPage() {
  const session = await getSession();
  if (session) redirect('/');
  return <LoginView />;
}
