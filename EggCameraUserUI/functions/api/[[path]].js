// /api/* を Mac mini の API（API_ORIGIN=https://api.siggaze.com 想定）へ透過リバースプロキシ。
// 雛形は ../../../EggCameraPages/functions/image/[id].js のストリーム素通し方式。
// SSE(/api/events) と MJPEG(/api/preview/stream) は body をそのまま流す（消費・再エンコードしない）。
// 多層防御として管理/内部APIは 403 で遮断。上流(server.js 層2)を通すため X-EC-Proxy-Secret を付与。

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    // 多層防御: 管理/内部APIは取引先テストに一切露出しない（/api/admin は元々 ADMIN_TOKEN 保護）
    if (url.pathname.startsWith('/api/internal/') ||
        url.pathname.startsWith('/api/admin/')) {
        return new Response('forbidden', { status: 403 });
    }

    if (!env.API_ORIGIN) {
        return new Response('API_ORIGIN not configured', { status: 500 });
    }
    const upstream = new URL(env.API_ORIGIN);
    upstream.pathname = url.pathname;   // /api/... をそのまま
    upstream.search   = url.search;

    // ヘッダ透過。入口Cookie(ec_access)と Host は上流へ渡さない。
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('cookie');
    if (env.EC_PROXY_SECRET) headers.set('X-EC-Proxy-Secret', env.EC_PROXY_SECRET);
    // 末端クライアントの実IP（server.js のレート制限キー CF-Connecting-IP を維持）
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) headers.set('CF-Connecting-IP', ip);

    const init = {
        method: request.method,
        headers,
        redirect: 'manual',
    };
    // GET/HEAD 以外は body をストリームのまま流す（/composite の生バイナリ対応）
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = request.body;
        init.duplex = 'half';
    }

    const resp = await fetch(upstream.toString(), init);

    // body はストリームのまま返す（SSE/MJPEG をバッファしない）。
    // content-encoding/length は fetch がデコード済みのため引き継がず、二重解凍・長さ不整合を避ける。
    const respHeaders = new Headers(resp.headers);
    respHeaders.delete('content-encoding');
    respHeaders.delete('content-length');
    return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: respHeaders,
    });
}
