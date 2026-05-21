import type { CSSProperties } from 'react';
import { IPad } from '../IPad';
import { Page } from '../Page';
import { useLang } from '../../LangContext';
import flameImg from '../../assets/flame.png';
import babyImg  from '../../assets/baby2.png';

const C = {
  number:  'var(--color-brand-400)',
  caption: 'var(--color-brand-600)',
  sparkle: 'var(--color-brand-200)',
  dot:     'var(--color-brand-100)',
};

interface FinalPreviewProps {
  nickname:   string;
  days:       number;
  frameLabel: string;
  onNext: () => void;
}

export function FinalPreview({ nickname, days, onNext }: FinalPreviewProps) {
  const { T } = useLang();
  const daysText = days > 0 ? T.preview.daysSinceBirth(days) : '';

  return (
    <IPad step={4} totalSteps={7} animKey="preview">
      <Page data-section="preview-screen" style={{ paddingTop: 24, paddingBottom: 28 }}>

        {/* Header — decorative, mirrors Birthday number display */}
        <div data-ui="preview-header" style={{ marginBottom: 16, flexShrink: 0, textAlign: 'center' }}>
          <div className="t-eyebrow" style={{ marginBottom: 10 }}>{T.preview.step}</div>

          <div style={{ display: 'inline-block', position: 'relative' }}>
            {/* Sparkles — scaled ~0.5× from Birthday */}
            <Sparkle size={14} color={C.sparkle} style={{ position: 'absolute', top: -14, left:  -36 }} />
            <Sparkle size={9}  color={C.dot}     style={{ position: 'absolute', top:  13, left:  -44 }} />
            <Sparkle size={11} color={C.sparkle} style={{ position: 'absolute', top:  46, left:  -28 }} />
            <Sparkle size={7}  color={C.dot}     style={{ position: 'absolute', top: -20, left:   18 }} />
            <Sparkle size={10} color={C.sparkle} style={{ position: 'absolute', top: -11, right: -24 }} />
            <Sparkle size={12} color={C.dot}     style={{ position: 'absolute', top:  24, right: -44 }} />
            <Sparkle size={8}  color={C.sparkle} style={{ position: 'absolute', top:  56, right: -20 }} />
            <Sparkle size={9}  color={C.dot}     style={{ position: 'absolute', top:  70, left:    8 }} />
            {/* Dots */}
            <Dot size={5} color={C.number}  style={{ position: 'absolute', top:   5, left:  -56 }} />
            <Dot size={4} color={C.dot}     style={{ position: 'absolute', top:  32, left:  -52 }} />
            <Dot size={4} color={C.sparkle} style={{ position: 'absolute', top:  -5, left:   40 }} />
            <Dot size={5} color={C.dot}     style={{ position: 'absolute', top:   4, right: -42 }} />
            <Dot size={4} color={C.number}  style={{ position: 'absolute', top:  46, right: -56 }} />
            <Dot size={4} color={C.sparkle} style={{ position: 'absolute', top:  72, right:  -6 }} />
            <Dot size={3} color={C.number}  style={{ position: 'absolute', top:  78, left:  -12 }} />
            <Dot size={4} color={C.sparkle} style={{ position: 'absolute', top: -17, right:  12 }} />

            <div style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontStyle: 'italic', fontWeight: 500,
              fontSize: 56, lineHeight: 1,
              color: C.number,
              position: 'relative', zIndex: 1,
            }}>{T.preview.heading}</div>
          </div>

          <div style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 13, fontWeight: 400,
            color: C.caption,
            marginTop: 10, letterSpacing: '0.04em',
          }}>{T.preview.subheading}</div>
        </div>

        {/* Photo composite */}
        <div data-ui="photo-composite" style={{
          flex: 1, minHeight: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40
        }}>
          <div style={{
            position: 'relative',
            aspectRatio: '2/3',
            height: '100%',
            borderRadius: 4,
            overflow: 'hidden',
            border: '1.5px solid var(--color-brand-100)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.1)',
          }}>
            <img src={babyImg} alt="photo"
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            <img src={flameImg} alt="frame overlay"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill', display: 'block', pointerEvents: 'none' }} />

            {/* Name & days badge — "famichan / 365 days since the birth" style */}
            {(nickname || daysText) && (
              <div data-ui="name-badge" style={{
                position: 'absolute', top: 20, left: 0, right: 0,
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
                pointerEvents: 'none',
              }}>
                {nickname && (
                  <div style={{
                    fontFamily: "'Nunito', 'Noto Sans JP', sans-serif",
                    fontSize: 50, fontWeight: 900,
                    letterSpacing: '-0.01em',
                    color: '#fff',
                    textShadow: '0 2px 10px rgba(0,0,0,0.35)',
                    lineHeight: 1.1,
                  }}>{nickname}</div>
                )}
                {daysText && (
                  <div style={{
                    fontFamily: "'Nunito', 'Noto Sans JP', sans-serif",
                    fontSize: 30, fontWeight: 800,
                    letterSpacing: '0.01em',
                    color: 'rgba(255,255,255,0.95)',
                    textShadow: '0 1px 6px rgba(0,0,0,0.35)',
                    lineHeight: 1.2,
                  }}>{daysText}</div>
                )}
              </div>
            )}

            {/* Watermark */}
            <div style={{
              position: 'absolute', bottom: 10, right: 14,
              fontFamily: 'Cormorant Garamond, serif', fontStyle: 'italic',
              fontSize: 11, color: 'rgba(81,143,204,0.6)', letterSpacing: '0.1em',
              pointerEvents: 'none',
            }}>Egg Camera</div>
          </div>
        </div>

        {/* Frame label — prominent warm */}
        {/* {frameLabel && (
          <div data-ui="frame-label" style={{
            flexShrink: 0, display: 'flex', justifyContent: 'center', marginTop: 14,
          }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              background: '#e76f66', color: '#fff',
              borderRadius: 99, padding: '8px 22px',
              boxShadow: '0 3px 12px rgba(210,118,74,0.35)',
            }}>
              <span style={{
                fontFamily: 'Noto Sans JP', fontSize: 10, fontWeight: 400,
                letterSpacing: '0.16em', opacity: 0.8,
              }}>{T.preview.frameLabel}</span>
              <span style={{
                fontFamily: 'Noto Sans JP', fontSize: 17, fontWeight: 700,
                letterSpacing: '0.04em',
              }}>{frameLabel}</span>
            </div>
          </div>
        )} */}

        <div style={{ flexShrink: 0, marginTop: 14 }}>
          <button className="btn-primary" onClick={onNext}>{T.preview.save}</button>
        </div>
      </Page>
    </IPad>
  );
}

// ── Decorative components (same design as Birthday) ──────────────
interface DecoProps {
  size?: number;
  color: string;
  style?: CSSProperties;
}

function Sparkle({ size = 14, color, style }: DecoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" style={style}>
      <path
        d="M10 1 L11.4 8.6 L19 10 L11.4 11.4 L10 19 L8.6 11.4 L1 10 L8.6 8.6 Z"
        fill={color}
      />
    </svg>
  );
}

function Dot({ size = 6, color, style }: DecoProps) {
  return (
    <span style={{
      display: 'inline-block',
      width: size, height: size,
      borderRadius: '50%',
      background: color,
      ...style,
    }} />
  );
}
