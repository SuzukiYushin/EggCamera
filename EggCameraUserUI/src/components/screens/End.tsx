import { IPad } from '../IPad';
import { useLang } from '../../LangContext';
import bearImg from '../../assets/bear_thanks.png';

interface EndProps {
  onRestart: () => void;
  // QRを撮り損ねた客の救済: セッション結果が残っている間だけQR画面へ戻れる。
  // （QR画面の3分タイムアウトで自動的にここへ来た直後が主な利用場面）
  onShowQr?: () => void;
}

export function End({ onRestart, onShowQr }: EndProps) {
  const { T } = useLang();

  return (
    <IPad animKey="end">
      <div data-section="end-screen" style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center',
        background: 'var(--color-brand-500)',
        padding: '72px 40px 52px',
      }}>

        {/* Thanks! heading */}
        <div style={{
          fontFamily: "var(--font-futura)",
          fontSize: 64, fontWeight: 700,
          color: '#F6F3E9',
          letterSpacing: '0.02em',
          lineHeight: 1,
          textAlign: 'center',
          marginBottom: 20,
        }}>{T.end.heading}</div>

        {/* Body text */}
        <div style={{
          fontFamily: "var(--font-ui)",
          fontSize: 18, fontWeight: 400,
          color: '#F6F3E9',
          textAlign: 'center',
          lineHeight: 1.9,
          letterSpacing: '0.1em',
          whiteSpace: 'pre-line',
          marginBottom: 32,
        }}>{T.end.body}</div>

        {/* Bear mascot — waving */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <img
            src={bearImg}
            alt=""
            aria-hidden="true"
            style={{
              width: 320, height: 'auto',
              objectFit: 'contain',
              display: 'block',
            }}
          />
        </div>

        {/* Restart button（DOM順で先頭を維持: ハーネスのボタン検出前提を守る） */}
        <div style={{ width: '100%', flexShrink: 0 }}>
          <button className="btn-cream" onClick={onRestart}>
            {T.end.restart}
          </button>
          {onShowQr && (
            <button
              onClick={onShowQr}
              style={{
                width: '100%', marginTop: 14,
                background: 'transparent', color: '#F6F3E9',
                border: '1.5px solid rgba(246,243,233,0.6)',
                borderRadius: 999, padding: '12px 28px',
                fontFamily: 'var(--font-ui)', fontSize: 16, fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {T.end.showQr}
            </button>
          )}
        </div>

      </div>
    </IPad>
  );
}
