import { IPad } from '../IPad';
import { Page } from '../Page';
import { useLang } from '../../LangContext';
import flameImg from '../../assets/flame.png';
import babyImg  from '../../assets/baby2.png';

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

        {/* Header */}
        <div data-ui="preview-header" style={{ marginBottom: 16, flexShrink: 0 }}>
          <div className="t-eyebrow" style={{ marginBottom: 6 }}>{T.preview.step}</div>
          <div className="t-heading" style={{ fontSize: 24 }}>{T.preview.heading}</div>
          <div className="t-body" style={{ fontSize: 13, marginTop: 2, color: 'var(--color-ink-400)' }}>{T.preview.subheading}</div>
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
