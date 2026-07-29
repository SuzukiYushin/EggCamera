import { createPortal } from 'react-dom';
import { IPad } from '../IPad';
import { useLang } from '../../LangContext';
import { PROTO } from '../../api';
import bearImg from '../../assets/bear_start.png';
import familiarLogo from '../../assets/familiar_logo.svg';

interface StartProps {
  onNext: () => void;
}

export function Start({ onNext }: StartProps) {
  const { lang, setLang, T } = useLang();

  // 言語トグルの配置（[[camera-fit-cover]] のフルブリードcover化に対応。QuitFlowと同じ方針）。
  // 本番: viewport基準 fixed ＋ safe-area。scale されるキャンバス内(absolute)だと cover の上端crop
  //   や非全画面Safariのツールバーに隠れるため、document.body へポータルしてキャンバスの
  //   transform から外し、safe-area/ツールバーの下に必ず出す。
  // プロト: iPad枠(768×1024)内に absolute で収める（従来どおり）。
  const langToggle = (
    <div data-ui="lang-toggle" style={{
      ...(PROTO
        ? { position: 'absolute' as const, top: 27, right: 32 }
        : {
            position: 'fixed' as const,
            top: 'calc(env(safe-area-inset-top, 0px) + 14px)',
            right: 'calc(env(safe-area-inset-right, 0px) + 18px)',
          }),
      display: 'flex', flexDirection: 'column', gap: 12, zIndex: 100,
    }}>
      {(['ja', 'en'] as const).map(l => (
        <button
          key={l}
          onClick={() => setLang(l)}
          style={{
            width: 92, height: 31,
            border: 'none',
            borderRadius: 99,
            background: lang === l ? '#06236F' : '#F6F3E9',
            color: lang === l ? '#F6F3E9' : '#06236F',
            fontFamily: "var(--font-ui)",
            fontSize: 13, fontWeight: 500,
            letterSpacing: '0.06em',
            cursor: 'pointer',
            transition: 'all 0.2s',
            whiteSpace: 'nowrap',
            boxShadow: PROTO ? 'none' : '0 2px 8px rgba(0,0,0,0.12)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          {l === 'ja' ? '日本語' : 'English'}
        </button>
      ))}
    </div>
  );

  return (
    <>
    <IPad animKey="start">
      <div data-section="start-screen" style={{
        position: 'relative',
        flex: 1,
        overflow: 'hidden',
        background: 'var(--color-brand-500)',
      }}>

        {/* Language toggle: プロトは枠内 absolute、本番は viewport 固定(下のポータル) */}
        {PROTO && langToggle}

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

        {/* Bear — top:467px, width 417px。画像が横長構図＋余白多めに差し替わったため、
            以前の縦長画像(width:322px)と見た目の熊の大きさが揃うよう幅を再調整。
            縦位置はタグライン〜熊、熊〜CTAボタンの余白が実測で均等になるよう調整（旧424だと上寄り） */}
        <img
          src={bearImg}
          alt=""
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 467,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 417,
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
    {!PROTO && createPortal(langToggle, document.body)}
    </>
  );
}
