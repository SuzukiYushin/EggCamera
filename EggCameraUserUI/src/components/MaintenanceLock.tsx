// メンテナンス中（再起動後のセルフテスト〜スタッフのOK待ち）にキオスク全体を
// ロックする全画面オーバーレイ。ユーザー操作を一切受け付けない。
export function MaintenanceLock() {
  return (
    <div data-section="maintenance-lock" style={{
      position: 'fixed', inset: 0, zIndex: 9998,
      background: 'var(--color-brand-600)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      textAlign: 'center', padding: 48,
    }}>
      <div style={{
        fontFamily: 'var(--font-ui)', fontSize: 26, fontWeight: 700,
        color: '#fff', lineHeight: 2.2, letterSpacing: '0.06em',
      }}>
        ただいまメンテナンス中です<br />
        少々お待ちください
      </div>
    </div>
  );
}
