import { IPad } from '../IPad';

interface EndProps {
  onRestart: () => void;
}

export function End({ onRestart }: EndProps) {
  return (
    <IPad step={7} totalSteps={7} animKey="end">
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '64px 72px', gap: 40,
        background: 'linear-gradient(160deg, #E6EEF7 0%, #ffffff 60%)',
      }}>
        <div style={{
          width: 96, height: 96, borderRadius: '50%',
          background: 'var(--color-brand-500)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 6px 24px rgba(81,143,204,0.35)',
        }}>
          <svg width="42" height="42" viewBox="0 0 42 42" fill="none">
            <path d="M8 21l9 10L34 12"
              stroke="white" strokeWidth="3.5"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="t-heading">ありがとうございました</div>
          <div className="t-body" style={{ lineHeight: 1.9 }}>
            写真はスマホに保存されています。<br />
            またのご来店をお待ちしております。
          </div>
          <div style={{
            fontFamily: 'Cormorant Garamond, serif', fontStyle: 'italic',
            fontSize: 14, color: 'var(--color-ink-200)', marginTop: 8,
            letterSpacing: '0.12em',
          }}>familiar</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, width: '100%' }}>
          <button className="btn-primary" onClick={onRestart}>TOPに戻る</button>
          {/* <button className="btn-ghost" onClick={onRestart}>終了する</button> */}
        </div>
      </div>
    </IPad>
  );
}
