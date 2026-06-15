// R2 公開ベースURLは Pages の環境変数 R2_PUBLIC_BASE_URL で設定する
// （Cloudflare Pages → Settings → Environment variables）。未設定時のみ従来値にフォールバック。
const R2_BASE_FALLBACK = 'https://pub-c35d182b845942f3b26d0ed65d668e0d.r2.dev';

export async function onRequestGet(context) {
    const R2_BASE = context.env?.R2_PUBLIC_BASE_URL || R2_BASE_FALLBACK;
    const id  = context.params.id;
    const res = await fetch(`${R2_BASE}/${id}`);

    if (!res.ok) {
        return new Response('Not found', { status: 404 });
    }

    return new Response(res.body, {
        headers: {
            'Content-Type':  'image/jpeg',
            'Cache-Control': 'private, max-age=259200',
        },
    });
}
