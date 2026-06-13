// EggCamera デッドマンスイッチ（Cloudflare Worker）
// Mac mini が定期的に POST /beat してくる。Cron Trigger が Cloudflare 側で独立に
// 動き、一定時間ビートが途絶えたら Slack に通知する。Mac mini が丸ごと落ちても
// この Worker は動き続けるので「全部死んだ」を確実に検知できる。
//
// 必要な設定（wrangler secret / KV）:
//   KV namespace binding: WATCHDOG
//   secret BEAT_SECRET          : /beat に要求する共有シークレット
//   secret SLACK_WEBHOOK_URL     : 通知先

const STALE_MS  = 15 * 60 * 1000; // 15分ビートが無ければ異常
const KEY_BEAT  = 'last_beat';
const KEY_STATE = 'alert_state';  // 'ok' | 'alerted'

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/beat') {
      const secret = url.searchParams.get('secret') || req.headers.get('X-Beat-Secret');
      if (!env.BEAT_SECRET || secret !== env.BEAT_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      await env.WATCHDOG.put(KEY_BEAT, String(Date.now()));
      // 復旧したら通知して状態を戻す
      const state = await env.WATCHDOG.get(KEY_STATE);
      if (state === 'alerted') {
        await notify(env, ':white_check_mark: Mac mini からのハートビートが回復しました。', 'good');
        await env.WATCHDOG.put(KEY_STATE, 'ok');
      }
      return new Response('ok');
    }

    // 状態確認用（GET /）
    const last = parseInt(await env.WATCHDOG.get(KEY_BEAT) || '0', 10);
    const ageSec = last ? Math.round((Date.now() - last) / 1000) : null;
    return Response.json({ lastBeat: last || null, ageSec, staleMs: STALE_MS });
  },

  // Cron Trigger（*/5 * * * *）。Cloudflare 側で独立実行される。
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const last = parseInt(await env.WATCHDOG.get(KEY_BEAT) || '0', 10);
      const state = await env.WATCHDOG.get(KEY_STATE) || 'ok';
      if (!last) return; // まだ一度もビートが無い（初期）
      const age = Date.now() - last;
      if (age > STALE_MS && state !== 'alerted') {
        const min = Math.round(age / 60000);
        await notify(env,
          `:rotating_light: *EggCamera 死活監視*\nMac mini からのハートビートが ${min} 分途絶えています。`
          + `サーバ/電源/ネットワークを確認してください。`, 'danger');
        await env.WATCHDOG.put(KEY_STATE, 'alerted');
      }
    })());
  },
};

async function notify(env, text, color) {
  if (!env.SLACK_WEBHOOK_URL) return;
  try {
    await fetch(env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, attachments: color ? [{ color, text: ' ' }] : undefined }),
    });
  } catch { /* 通知失敗は握りつぶす */ }
}
