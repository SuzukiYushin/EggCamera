import { IPad } from '../IPad';

interface StartProps {
  onNext: () => void;
}

export function Start({ onNext }: StartProps) {
  return (
    <IPad animKey="start">
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        background: 'linear-gradient(160deg, #EDF4FA 0%, #ffffff 60%)',
      }}>

        {/* Brand — vertically centred */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: '0 48px', textAlign: 'center',
        }}>
          <div style={{
            fontFamily: 'Cormorant Garamond, serif',
            fontSize: 12, fontWeight: 300,
            letterSpacing: '0.36em', color: 'var(--color-ink-300)',
            textTransform: 'uppercase', marginBottom: 18,
          }}>familiar</div>

          <div style={{
            fontFamily: 'Cormorant Garamond, serif',
            fontSize: 56, fontWeight: 400,
            letterSpacing: '0.04em', lineHeight: 1,
            color: 'rgb(112, 112, 112)',
          }}>Egg Camera</div>

          <div style={{
            fontFamily: 'Noto Sans JP', fontSize: 14,
            color: 'var(--color-ink-300)', marginTop: 18, letterSpacing: '0.12em',
          }}>お子様をベッドの中央に寝かせてください。</div>
        </div>

        {/* CTA */}
        <div style={{ padding: '0 48px 60px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          <button
            className="btn-primary"
            style={{ fontSize: 17, height: 64, borderRadius: 4, letterSpacing: '0.22em' }}
            onClick={onNext}
          >
            はじめる
          </button>
          <span className="t-caption">タップしてスタート</span>
        </div>

      </div>
    </IPad>
  );
}
