import { IPad } from '../IPad';
import { useLang } from '../../LangContext';

interface StartProps {
  onNext: () => void;
}

export function Start({ onNext }: StartProps) {
  const { lang, setLang, T } = useLang();

  return (
    <IPad animKey="start">
      <div data-section="start-screen" style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        background: 'linear-gradient(160deg, #EDF4FA 0%, #ffffff 60%)',
      }}>

        {/* Language toggle */}
        <div data-ui="lang-toggle" style={{
          position: 'absolute', top: 40, right: 28,
          display: 'flex', gap: 4,
        }}>
          {(['ja', 'en'] as const).map(l => (
            <button
              key={l}
              onClick={() => setLang(l)}
              style={{
                padding: '4px 10px',
                border: '1.5px solid',
                borderColor: lang === l ? 'var(--color-brand-500)' : 'var(--color-gray-200)',
                borderRadius: 99,
                background: lang === l ? 'var(--color-brand-500)' : 'transparent',
                color: lang === l ? '#fff' : 'var(--color-ink-400)',
                fontFamily: 'Noto Sans JP',
                fontSize: 11, fontWeight: 500,
                letterSpacing: '0.08em',
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>

        {/* Brand — vertically centred */}
        <div data-ui="brand" style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: '0 48px', textAlign: 'center',
        }}>
          <div style={{
            fontFamily: 'Cormorant Garamond, serif',
            fontStyle: 'italic',
            fontSize: 13, fontWeight: 300,
            letterSpacing: '0.28em', color: 'var(--color-ink-300)',
            marginBottom: 18,
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
          }}>{T.start.tagline}</div>
        </div>

        {/* CTA */}
        <div data-ui="cta" style={{ padding: '0 48px 60px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          <button
            className="btn-primary"
            style={{ fontSize: 17, height: 64, borderRadius: 4, letterSpacing: '0.22em' }}
            onClick={onNext}
          >
            {T.start.cta}
          </button>
          <span className="t-caption">{T.start.tap}</span>
        </div>

      </div>
    </IPad>
  );
}
