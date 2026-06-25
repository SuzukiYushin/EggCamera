// /frames/* （フレーム画像の静的配信 server.js:145）を Mac mini へ透過プロキシ。
// GET のみ。/api/* と同じく上流(server.js 層2)を通すため X-EC-Proxy-Secret を付与する。

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    if (!env.API_ORIGIN) {
        return new Response('API_ORIGIN not configured', { status: 500 });
    }
    const upstream = new URL(env.API_ORIGIN);
    upstream.pathname = url.pathname;   // /frames/...
    upstream.search   = url.search;

    const headers = new Headers();
    if (env.EC_PROXY_SECRET) headers.set('X-EC-Proxy-Secret', env.EC_PROXY_SECRET);
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) headers.set('CF-Connecting-IP', ip);

    const resp = await fetch(upstream.toString(), { method: 'GET', headers });

    const respHeaders = new Headers(resp.headers);
    respHeaders.delete('content-encoding');
    respHeaders.delete('content-length');
    // フレーム画像はほぼ不変なのでブラウザ/CDN キャッシュを許可（上流が未指定の場合のみ）
    if (!respHeaders.has('Cache-Control')) {
        respHeaders.set('Cache-Control', 'public, max-age=300');
    }
    return new Response(resp.body, { status: resp.status, headers: respHeaders });
}
