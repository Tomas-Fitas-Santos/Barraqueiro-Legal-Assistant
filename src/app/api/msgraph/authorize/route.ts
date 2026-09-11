import { randomBytes } from 'node:crypto';

import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { setSetting } from '@/lib/server/db';
import { appBaseUrl, buildAuthorizeUrl, GRAPH_CALLBACK_PATH } from '@/lib/server/msgraph';

// Start the delegated Microsoft sign-in. Single-user app: one flow at a time, its state
// held in settings with a short TTL and cleared by the callback.
export async function POST(req: Request) {
  return withSession(async () => {
    const state = randomBytes(18).toString('base64url');
    const redirectUri = `${appBaseUrl(req)}${GRAPH_CALLBACK_PATH}`;
    setSetting('graph.oauth_state', JSON.stringify({ state, redirectUri, createdAt: Date.now() }));
    return NextResponse.json({ ok: true, authorizationUrl: buildAuthorizeUrl(redirectUri, state) });
  });
}
