// フロントで起きたエラーの詳細をサーバログへ送る（Sentry的な最小実装）。
// オーバーレイが出た「理由」を data/logs/ と管理画面ログタブで追えるようにする。
export function reportClientError(message: string) {
  try {
    const screen =
      document.querySelector('[data-section]')?.getAttribute('data-section') ?? '';
    const body = JSON.stringify({
      level: 'error',
      message: String(message).slice(0, 2000),
      screen,
    });
    const sent = navigator.sendBeacon?.(
      '/api/client-log',
      new Blob([body], { type: 'application/json' }),
    );
    if (!sent) {
      fetch('/api/client-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  } catch { /* ログ送信自体の失敗でアプリを壊さない */ }
}
