import { useEffect } from 'react';

// 全画面共通のエラー表示。ボタン・閉じる×は置かず、
// 一定時間表示したあと自動でリロードしてトップに戻る。
const RELOAD_AFTER_MS = 10_000;

export function ErrorOverlay() {
  useEffect(() => {
    const t = setTimeout(() => window.location.reload(), RELOAD_AFTER_MS);
    return () => clearTimeout(t);
  }, []);

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
