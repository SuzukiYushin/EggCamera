// EggCamera Slack Bot（Socket Mode）。
// Mac mini から Slack へ外向き接続するので、公開ポート/トンネル不要（NAT内でも動く）。
// トークンは ~/EggCamera/.env.slackbot（git管理外）から読む:
//   SLACK_BOT_TOKEN=xoxb-...
//   SLACK_APP_TOKEN=xapp-...        （Socket Mode 用 App-Level Token）
//   SLACK_ALLOWED_USERS=U123,U456   （任意。指定時はこのユーザーのみ操作可）
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const actions = require('./actions');

// ── CLIテストモード（Slack不要） ──
//   node bot.js test <safe cmd>        例) test status
//   node bot.js test-reboot <danger>   例) test-reboot help / test-reboot mac
if (process.argv[2] === 'test') {
  actions.run(process.argv.slice(3).join(' ')).then(r => { console.log(r); process.exit(0); });
  return;
}
if (process.argv[2] === 'test-reboot') {
  actions.runDanger(process.argv.slice(3).join(' ')).then(r => { console.log(r); process.exit(0); });
  return;
}

// .env.slackbot を読む
(() => {
  try {
    const f = path.join(os.homedir(), 'EggCamera', '.env.slackbot');
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch { /* 未設定なら下で弾く */ }
})();

if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) {
  console.error('SLACK_BOT_TOKEN / SLACK_APP_TOKEN が未設定です（~/EggCamera/.env.slackbot）。');
  process.exit(1);
}

const { App } = require('@slack/bolt');
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const ALLOWED = (process.env.SLACK_ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
function allowed(userId) { return ALLOWED.length === 0 || ALLOWED.includes(userId); }

// スラッシュコマンド /egg
app.command('/egg', async ({ command, ack, respond }) => {
  await ack();
  if (!allowed(command.user_id)) {
    await respond({ response_type: 'ephemeral', text: ':no_entry: このコマンドの実行権限がありません。' });
    return;
  }
  const sub = (command.text || '').trim();
  // 重い操作は先に受付メッセージ
  if (/^(restart|refresh)/.test(sub)) {
    await respond({ response_type: 'in_channel', text: `:hourglass_flowing_sand: 実行中: \`/egg ${sub}\` …` });
  }
  try {
    const result = await actions.run(sub);
    await respond({ response_type: 'in_channel', text: result });
  } catch (err) {
    await respond({ response_type: 'in_channel', text: `:x: エラー: ${err.message}` });
  }
});

// 危険系（本体リブート）専用コマンド /egg-reboot（confirm 必須）
app.command('/egg-reboot', async ({ command, ack, respond }) => {
  await ack();
  if (!allowed(command.user_id)) {
    await respond({ response_type: 'ephemeral', text: ':no_entry: このコマンドの実行権限がありません。' });
    return;
  }
  const sub = (command.text || '').trim();
  if (/confirm/i.test(sub)) {
    await respond({ response_type: 'in_channel', text: `:warning: 本体リブート実行: \`/egg-reboot ${sub}\` …` });
  }
  try {
    await respond({ response_type: 'in_channel', text: await actions.runDanger(sub) });
  } catch (err) {
    await respond({ response_type: 'in_channel', text: `:x: エラー: ${err.message}` });
  }
});

// @メンションでも status を返す（任意）
app.event('app_mention', async ({ event, say }) => {
  if (!allowed(event.user)) return;
  const text = event.text.replace(/<@[^>]+>/, '').trim();
  try { await say(await actions.run(text || 'status')); }
  catch (err) { await say(`:x: ${err.message}`); }
});

(async () => {
  await app.start();
  console.log('[eggcamera-bot] Socket Mode connected');
})();
