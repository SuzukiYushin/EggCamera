// この端末のエラー起因で表示するローカルのメンテナンス画面。
// 系統A（即時致命エラー後の自己復旧待ち）と系統B（アップロード遅延の診断中）で共用。
// グローバルの MaintenanceLock（全端末ロック）とは別物。復旧の判定・遷移は App.tsx が行い、
// ここは表示だけを担う。z-index は ErrorOverlay より下・MaintenanceLock と同等。
interface Props {
  // 'recovering' = 系統A（復旧を試行中） / 'diagnosing' = 系統B（接続を確認中）
  phase: 'recovering' | 'diagnosing';
}

export function LocalMaintenance({ phase }: Props) {
  const heading = 'ただいまメンテナンス中です';
  const body = phase === 'diagnosing'
    ? '通信状態を確認しています。\nそのままお待ちください'
    : '自動で復旧を試みています。\n少々お待ちください';

  return (
    <div data-section="local-maintenance" data-phase={phase} style={{
      position: 'fixed', inset: 0, zIndex: 9998,
      background: 'var(--color-brand-600)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      textAlign: 'center', padding: 48,
    }}>
      <div style={{
        fontFamily: 'var(--font-ui)', fontSize: 26, fontWeight: 700,
        color: '#fff', lineHeight: 2.0, letterSpacing: '0.06em', marginBottom: 24,
      }}>{heading}</div>
      <div style={{
        fontFamily: 'var(--font-ui)', fontSize: 16, fontWeight: 600,
        color: '#fff', lineHeight: 1.9, letterSpacing: '0.04em',
        whiteSpace: 'pre-line', opacity: 0.92,
      }}>{body}</div>
    </div>
  );
}
