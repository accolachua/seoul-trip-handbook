const UPSTREAM = 'https://seoul-trip-handbook.604107556.workers.dev';

export async function onRequest({ request }) {
  const source = new URL(request.url);
  const target = new URL(source.pathname + source.search, UPSTREAM);
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('origin');
  headers.delete('referer');

  const init = { method: request.method, headers, redirect: 'follow' };
  if (!['GET', 'HEAD'].includes(request.method)) init.body = await request.arrayBuffer();

  try {
    const upstream = await fetch(target.toString(), init);
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set('cache-control', 'no-store');
    responseHeaders.delete('access-control-allow-origin');
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return new Response(JSON.stringify({ ok: false, error: '共享服务暂不可用，请稍后重试' }), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}
