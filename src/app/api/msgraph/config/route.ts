import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { getSetting, setSetting } from '@/lib/server/db';
import { isGraphConfigured, isGraphConnected, isLibraryConfigured } from '@/lib/server/msgraph';
import { lastSync } from '@/lib/server/repo/library';
import { getSecretSetting, setSecretSetting } from '@/lib/server/secrets';

// The Microsoft 365 configuration surface. The client secret is WRITE-ONLY: it is stored
// encrypted and never returned — only whether one is set.
export async function GET() {
  return withSession(async () => {
    return NextResponse.json({
      ok: true,
      tenantId: String(getSetting('graph.tenant_id') || ''),
      clientId: String(getSetting('graph.client_id') || ''),
      clientSecretSet: Boolean(getSecretSetting('graph.client_secret')),
      configured: isGraphConfigured(),
      connected: isGraphConnected(),
      accountEmail: String(getSetting('graph.account_email') || ''),
      accountName: String(getSetting('graph.account_name') || ''),
      libraryConfigured: isLibraryConfigured(),
      libraryFolderName: String(getSetting('graph.library_folder_name') || ''),
      lastSync: lastSync(),
    });
  });
}

export async function PATCH(req: Request) {
  return withSession(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.tenantId === 'string') setSetting('graph.tenant_id', body.tenantId.trim());
    if (typeof body.clientId === 'string') setSetting('graph.client_id', body.clientId.trim());
    // Empty string clears; absent field leaves the stored secret untouched.
    if (typeof body.clientSecret === 'string') setSecretSetting('graph.client_secret', body.clientSecret);
    return NextResponse.json({ ok: true, configured: isGraphConfigured() });
  });
}
