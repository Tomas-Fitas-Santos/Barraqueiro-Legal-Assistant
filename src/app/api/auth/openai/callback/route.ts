import { codexOauth } from '@/lib/server/ai/vendor/codex-oauth';

// OAuth redirect target — necessarily unauthenticated (the provider sends the browser
// here); the signed `state` from an authorize call is what legitimises the request.
function html(message: string): string {
  const safe = String(message || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return (
    "<!doctype html><html><head><meta charset='utf-8'/><title>Authorization</title>" +
    '<style>body{font-family:sans-serif;padding:24px;}h3{margin:0 0 8px;}p{margin:0;}</style>' +
    '</head><body>' +
    `<h3>${safe}</h3>` +
    '<p>You can close this tab and return to the Legal Assistant.</p>' +
    '<script>setTimeout(function(){window.close();},1200);</script>' +
    '</body></html>'
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error_description') || url.searchParams.get('error');

  const result = await codexOauth().handleBrowserCallback({ code, state, error });
  return new Response(html(result.message), {
    status: result.status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
