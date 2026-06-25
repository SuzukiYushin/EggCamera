// 入口認証（層1）: 共有アクセスキー。Zero Trust を使わずダッシュボード操作ゼロで取引先を限定する。
// 取引先には ?key=<ACCESS_KEY> 付きURL（例 https://eggcamera-userui.pages.dev/?key=◯◯）を渡す。
// 正しいキーで来たら Cookie(ec_access) をセットして key を除いたURLへ 302、以降は Cookie で通す。
// キーが無効/未提示なら 401 のキー入力ページを返す。ACCESS_KEY は Pages 環境変数。
// ACCESS_KEY 未設定なら認証を無効化（＝素通し。段階導入・ロールバック用）。
//
// _routes.json の include:["/*"] により全リクエスト（静的アセット含む）がこの middleware を通る。
// 認証OKなら context.next() で静的アセット / api・frames の各 Function へフォールスルーする。

const COOKIE_NAME = 'ec_access';

export async function onRequest(context) {
    const { request, env, next } = context;
    const KEY = env.ACCESS_KEY;

    // キー未設定なら認証スキップ（素通し）
    if (!KEY) return next();

    const url = new URL(request.url);

    // 1) Cookie に正しいキーがあれば通過
    const cookies = parseCookie(request.headers.get('Cookie') || '');
    if (cookies[COOKIE_NAME] === KEY) {
        return next();
    }

    // 2) ?key=... で来たら Cookie をセットし、key を除いたURLへ 302
    if (url.searchParams.get('key') === KEY) {
        url.searchParams.delete('key');
        const dest = url.pathname + (url.search || '');
        const headers = new Headers();
        headers.set('Location', dest || '/');
        // HttpOnly + Secure + SameSite=Lax、30日。
        headers.append('Set-Cookie',
            `${COOKIE_NAME}=${KEY}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`);
        return new Response(null, { status: 302, headers });
    }

    // 3) それ以外はキー入力ページ（401）
    return new Response(LOGIN_HTML, {
        status: 401,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
}

function parseCookie(str) {
    const out = {};
    for (const part of str.split(';')) {
        const i = part.indexOf('=');
        if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
}

const LOGIN_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EggCamera テスト</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;
    display:flex;align-items:center;justify-content:center;background:#faf8f5;color:#333}
  form{text-align:center;padding:2rem;max-width:20rem}
  p{margin:0 0 1rem;font-size:1rem}
  input{width:100%;box-sizing:border-box;font-size:1.1rem;padding:.7rem;
    border:1px solid #ccc;border-radius:10px}
  button{margin-top:1rem;width:100%;font-size:1.1rem;padding:.7rem;border:0;
    border-radius:10px;background:#e89ab0;color:#fff;cursor:pointer}
</style></head>
<body>
  <form method="GET" action="/">
    <p>アクセスキーを入力してください</p>
    <input name="key" type="password" autofocus autocomplete="off" placeholder="access key">
    <button type="submit">入る</button>
  </form>
</body></html>`;
