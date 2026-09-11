import { NextResponse } from 'next/server';

import { withSession } from '@/app/api/_helpers';
import { codexOauth, resolveOpenAICallbackBaseUrl } from '@/lib/server/ai/vendor/codex-oauth';

// Start a ChatGPT Plus/Pro connection. Ported thin from natenai/agent; the flow itself
// lives in the vendored codex-oauth module. Session-gated: only the signed-in user may
// bind a subscription to this deployment.
export async function POST(req: Request) {
  return withSession(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    let method = String(body.method || 'browser').trim().toLowerCase();
    if (!['browser', 'device'].includes(method)) method = 'browser';

    if (method === 'browser') {
      try {
        const data = await codexOauth().startBrowserFlow({
          callbackBaseUrl: resolveOpenAICallbackBaseUrl(req),
        });
        return NextResponse.json({
          ok: true,
          method: 'browser',
          authorizationUrl: data.authorization_url,
          authState: data.state,
        });
      } catch (error) {
        // Browser flow can fail when port 1455 is taken locally — fall through to device.
        const fallback = await codexOauth().startDeviceFlow();
        return NextResponse.json({
          ok: true,
          method: 'device',
          verificationUrl: fallback.verification_url,
          userCode: fallback.user_code,
          pollId: fallback.poll_id,
          intervalMs: fallback.interval_ms,
          fallbackReason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const data = await codexOauth().startDeviceFlow();
    return NextResponse.json({
      ok: true,
      method: 'device',
      verificationUrl: data.verification_url,
      userCode: data.user_code,
      pollId: data.poll_id,
      intervalMs: data.interval_ms,
    });
  });
}
