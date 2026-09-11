import { NextResponse } from 'next/server';

import { getSetting, setSetting } from '@/lib/server/db';

import { appBaseUrl, exchangeAuthCode } from '@/lib/server/msgraph';
import { forgetLibraryIfDriveChanged } from '@/lib/server/repo/library';

// OAuth redirect target — necessarily unauthenticated (Microsoft sends the browser here);
// the single-use `state` minted by an authenticated authorize call legitimises it.
const STATE_TTL_MS = 10 * 60 * 1000;

function settingsRedirect(req: Request, params: Record<string, string>): NextResponse {
  // NEVER req.url as the base: behind the proxy it is the container bind address.
  const url = new URL('/settings', appBaseUrl(req));
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const error = url.searchParams.get('error_description') || url.searchParams.get('error') || '';

  const storedRaw = String(getSetting('graph.oauth_state') || '');
  setSetting('graph.oauth_state', ''); // single-use, success or not
  let stored: { state?: string; redirectUri?: string; createdAt?: number } = {};
  try {
    stored = storedRaw ? JSON.parse(storedRaw) : {};
  } catch {
    stored = {};
  }

  if (!state || state !== stored.state || Date.now() - Number(stored.createdAt || 0) > STATE_TTL_MS) {
    return settingsRedirect(req, { ms: 'error', msDetail: 'Invalid or expired sign-in state. Try again.' });
  }
  if (error || !code) {
    return settingsRedirect(req, { ms: 'error', msDetail: error || 'Missing authorization code.' });
  }

  try {
    // Read before the exchange: signing in overwrites it with whoever just signed in.
    const previousAccountEmail = String(getSetting('graph.account_email') || '');
    await exchangeAuthCode(code, String(stored.redirectUri || ''));
    // Signing in as somebody else means a different drive, on which none of the ids the app
    // cached resolve — the library folder included. Clearing them here is what makes the
    // switch safe: the next step is choosing a folder, and the structure is built into it.
    const driveChanged = await forgetLibraryIfDriveChanged(previousAccountEmail);
    return settingsRedirect(req, driveChanged ? { ms: 'connected', msDrive: 'changed' } : { ms: 'connected' });
  } catch (err) {
    return settingsRedirect(req, {
      ms: 'error',
      msDetail: err instanceof Error ? err.message : String(err),
    });
  }
}
