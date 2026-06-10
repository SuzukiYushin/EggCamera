import { IPad } from '../IPad';
import { useLang } from '../../LangContext';
import bearImg from '../../assets/bear_thanks.png';

interface EndProps {
  onRestart: () => void;
}

export function End({ onRestart }: EndProps) {
  const { T } = useLang();

  return (
    <IPad animKey="end" statusBg="#F6F3E9" statusTextColor="var(--color-brand-600)">
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

        {/* Restart button */}
        <div style={{ width: '100%', flexShrink: 0 }}>
          <button className="btn-cream" onClick={onRestart}>
            {T.end.restart}
          </button>
        </div>

      </div>
    </IPad>
  );
}
