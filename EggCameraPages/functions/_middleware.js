// 地理制限（層0・日本国内限定）:
// DLページ（download/index.html）と画像配信（/image/:id）への、日本国外からのアクセスを遮断する。
// 判定は Cloudflare が付与する CF-IPCountry ヘッダ（request.cf.country と同値。例 "JP","US","XX"=不明,"T1"=Tor）。
// env GEO_ALLOW にカンマ区切り国コード（例 "JP"）。未設定ならデフォルト "JP"（デプロイのみで日本限定が有効）。
// 制限を解除したい場合は Pages 環境変数 GEO_ALLOW="OFF" を設定して再デプロイ。
// CF を通らない経路（ローカル開発・直アクセス）はヘッダ無し→通す（安全側）。
//
// 同階層の _routes.json の include:["/*"] により、静的アセットを含む全リクエストがこの middleware を通る。

const BLOCK_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ご利用いただけません / Not available</title>
<style>
  body{font-family:'Noto Sans JP',system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;
    display:flex;align-items:center;justify-content:center;background:#faf8f5;color:#333;text-align:center}
  .box{padding:2rem;max-width:24rem}
  h1{font-size:1.15rem;margin:0 0 1rem}
  p{margin:.3rem 0;font-size:.95rem;line-height:1.6;color:#666}
</style></head>
<body><div class="box">
  <h1>このページは日本国内からのみご利用いただけます</h1>
  <p>恐れ入りますが、日本国外からのアクセスはご利用いただけません。</p>
  <p>This service is available only from within Japan.</p>
</div></body></html>`;

export async function onRequest(context) {
    const { request, env, next } = context;
    // GEO_ALLOW 未設定ならデフォルト "JP"（デプロイのみで有効。Pages 環境変数の追加＝secret 破損リスクを避ける）。
    // 解除は GEO_ALLOW="OFF"。
    const raw = (env.GEO_ALLOW ?? 'JP').trim();
    if (!raw || raw.toUpperCase() === 'OFF') return next();
    const allow = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (allow.length === 0) return next();

    const country = request.headers.get('CF-IPCountry')
        || (request.cf && request.cf.country) || null;

    // country 不明（CF を通らない）は通す。許可国に含まれなければ 403。
    if (country && !allow.includes(country)) {
        return new Response(BLOCK_HTML, {
            status: 403,
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
    }
    return next();
}
