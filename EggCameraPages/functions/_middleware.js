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
  .box{padding:2rem;max-width:26rem;text-align:left}
  h1{font-size:1.15rem;margin:0 0 1rem;text-align:center}
  p{margin:.3rem 0;font-size:.9rem;line-height:1.7;color:#666}
  hr{border:none;border-top:1px solid #e5e0d8;margin:1.2rem 0}
  .en{color:#777}
</style></head>
<body><div class="box">
  <h1>このページは日本国内からのみご利用いただけます</h1>
  <p>恐れ入りますが、日本国外からのアクセスはご利用いただけません。</p>
  <p>日本国内でこの画面が表示された場合は、海外SIM・ローミング・VPN・iCloudプライベートリレーの影響で
     海外からのアクセスと判定されている可能性があります。Wi-Fiに接続するか、VPNやプライベートリレーを
     オフにしてから、このページを再読み込みしてください。</p>
  <hr>
  <p class="en" lang="en"><strong>This service is available only from within Japan.</strong></p>
  <p class="en" lang="en">Seeing this page while in Japan? Your connection may appear to come from overseas —
     this can happen with roaming SIMs, VPNs, or iCloud Private Relay. Please connect to Wi-Fi or turn off
     your VPN / Private Relay, then reload this page.</p>
</div></body></html>`;

// 正当な写真ID（familia_EggCamera_YYYY.MM.DD.HH.mm.ss）を伴う DLページ/画像リクエストは
// 国不問で通す。ID は QR コード経由でしか客に渡らない実質ワンタイムのトークン
// （秒精度タイムスタンプ＋24h で R2 から削除）であり、海外SIMローミング・VPN・
// iCloudプライベートリレー利用の正当な客（在日保護者など）が 403 で完全に詰む問題を解消する。
// ID 無しのアクセス（トップ・スキャン・bot 由来）は従来どおり許可国のみ。
const PHOTO_ID_RE = /^familia_EggCamera_\d{4}\.\d{2}\.\d{2}\.\d{2}\.\d{2}\.\d{2}$/;

function hasValidPhotoId(url) {
    const img = url.pathname.match(/^\/image\/(.+)\.jpg$/);
    if (img) return PHOTO_ID_RE.test(img[1].replace(/_preview$/, ''));
    if (url.pathname === '/download' || url.pathname === '/download/') {
        return PHOTO_ID_RE.test(url.searchParams.get('id') || '');
    }
    return false;
}

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
    // ただし正当な写真IDつきの DL/画像は国不問（上記コメント参照）。
    if (country && !allow.includes(country)) {
        if (hasValidPhotoId(new URL(request.url))) return next();
        return new Response(BLOCK_HTML, {
            status: 403,
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
    }
    return next();
}
