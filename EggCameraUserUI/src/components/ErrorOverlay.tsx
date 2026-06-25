// 全画面共通のお詫び表示（純粋に表示のみ）。
// 以前はここで location.reload() してトップへ戻していたが、「お詫びの後はトップではなく
// メンテ画面へ移し、裏で自己復旧する」方針に変更したため自動リロードは行わない。
// 表示時間と遷移先（→ローカルメンテ画面）は App.tsx が制御する。
// レンダリング例外の最終防壁は ErrorBoundary 側が担当（そちらは reload する）。
export function ErrorOverlay() {
  return (
    <div data-section="error-overlay" style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'var(--color-brand-600)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      textAlign: 'center', padding: 48,
    }}>
      <div style={{
        fontFamily: 'var(--font-ui)',
        fontSize: 26, fontWeight: 700,
        color: '#fff', lineHeight: 2.2,
        letterSpacing: '0.06em',
      }}>
        ご迷惑をおかけして申し訳ありません。<br />
        お近くのスタッフにお声掛けください
      </div>
    </div>
  );
}
