import { IPad } from '../IPad';
import { useLang } from '../../LangContext';
import bearImg from '../../assets/bear_start.png';
import familiarLogo from '../../assets/familiar_logo.svg';

interface StartProps {
  onNext: () => void;
}

export function Start({ onNext }: StartProps) {
  const { lang, setLang, T } = useLang();

  return (
    <IPad animKey="start">
      <div data-section="start-screen" style={{
        position: 'relative',
        flex: 1,
        overflow: 'hidden',
        background: 'var(--color-brand-500)',
      }}>

        {/* Language toggle — top:59-32=27px from screen area, right:32px */}
        <div data-ui="lang-toggle" style={{
          position: 'absolute', top: 27, right: 32,
          display: 'flex', flexDirection: 'column', gap: 15, zIndex: 10,
        }}>
          {(['ja', 'en'] as const).map(l => (
            <button
              key={l}
              onClick={() => setLang(l)}
              style={{
                width: 81, height: 27,
                border: 'none',
                borderRadius: 99,
                background: lang === l ? '#06236F' : '#F6F3E9',
                color: lang === l ? '#F6F3E9' : '#06236F',
                fontFamily: "var(--font-ui)",
                fontSize: 12, fontWeight: 500,
                letterSpacing: '0.06em',
                cursor: 'pointer',
                transition: 'all 0.2s',
                whiteSpace: 'nowrap',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {l === 'ja' ? '日本語' : 'English'}
            </button>
          ))}
        </div>

        {/* "familiar" — top:177-32=145px */}
        <div style={{
          position: 'absolute', top: 145, left: 0, right: 0,
          display: 'flex', justifyContent: 'center',
        }}>
          <img src={familiarLogo} alt="familiar" style={{ width: 179, height: 'auto' }} />
        </div>

        {/* "Egg Camera" — top:246-32=214px, cream color, tracking +20 */}
        <div style={{
          position: 'absolute', top: 214, left: 0, right: 0,
          textAlign: 'center',
        }}>
          <div style={{
            fontFamily: "var(--font-futura)",
            fontSize: 62, fontWeight: 700,
            color: '#F6F3E9',
            letterSpacing: '0.02em',
            lineHeight: 1.05,
          }}>Egg Camera</div>
        </div>

        {/* Tagline — top:353-32=321px, dark navy, tracking 100, scaleX 140% */}
        <div style={{
          position: 'absolute', top: 331, left: 0, right: 0,
          display: 'flex', justifyContent: 'center',
          overflow: 'hidden',
        }}>
          <div style={{
            fontFamily: "var(--font-ui)",
            fontSize: 19, fontWeight: 600,
            color: '#06236F',
            letterSpacing: '0.1em',
            transformOrigin: 'center',
            whiteSpace: 'nowrap',
          }}>{T.start.tagline}</div>
        </div>

        {/* Bear — top:456-32=424px, width 322px (design: 221.56pt × 1.453) */}
        <img
          src={bearImg}
          alt=""
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 424,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 322,
            height: 'auto',
            display: 'block',
          }}
        />

        {/* CTA button — top:920-32=888px, left/right:59px */}
        <div style={{
          position: 'absolute',
          top: 888, left: 59, right: 59,
        }}>
          <button
            className="btn-cream"
            style={{ animation: 'breathe 2.8s ease-in-out infinite' }}
            onClick={onNext}
          >
            {T.start.cta}
          </button>
        </div>

      </div>
    </IPad>
  );
}
