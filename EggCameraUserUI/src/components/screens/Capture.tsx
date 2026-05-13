import { useState, useEffect } from 'react';
import { IPad } from '../IPad';
import flameImg from '../../assets/flame.png';
import babyImg from '../../assets/baby.png';

interface CaptureProps {
  onNext: () => void;
}

export function Capture({ onNext }: CaptureProps) {
  const [count, setCount] = useState(1);

  useEffect(() => {
    if (count >= 6) {
      const t = setTimeout(onNext, 800);
      return () => clearTimeout(t);
      return;
    }
    const t = setTimeout(() => setCount(c => c + 1), 900);
    return () => clearTimeout(t);
  }, [count, onNext]);

  const done = count >= 6;

  return (
    <IPad step={4} animKey="capture">
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '12px 32px 20px' }}>

        {/* Header */}
        <div style={{ flexShrink: 0, marginBottom: 10 }}>
          <div className="t-eyebrow" style={{ marginBottom: 4 }}>ステップ 4 / 9</div>
          <div className="t-heading" style={{ fontSize: 20 }}>
            {done ? '撮影完了！' : '自動撮影中です'}
          </div>
        </div>

        {/* Camera preview — fills remaining height, 2:3 ratio */}
        <div style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}>
          <div style={{
            aspectRatio: '2 / 3',
            height: '100%',
            maxWidth: '100%',
            borderRadius: 8,
            overflow: 'hidden',
            background: '#000',
            border: '1.5px solid var(--color-brand-100)',
            position: 'relative',
          }}>
            <img
              src={babyImg}
              alt="カメラ映像"
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
            <img
              src={flameImg}
              alt="フレーム"
              style={{
                position: 'absolute', inset: 0,
                width: '100%', height: '100%', objectFit: 'fill',
                display: 'block', pointerEvents: 'none',
              }}
            />

            {/* Shutter flash */}
            <div key={count} style={{
              position: 'absolute', inset: 0,
              background: 'rgba(255,255,255,0)',
              animation: 'shutterFlash 0.3s ease-out',
              pointerEvents: 'none',
            }} />

            {/* Counter — overlaid top-left */}
            <div
              aria-live="polite"
              aria-atomic="true"
              aria-label={done ? '撮影完了' : `${count} 枚目を撮影中`}
              style={{
                position: 'absolute', top: 16, left: 16,
                display: 'flex', alignItems: 'baseline', gap: 4,
                background: 'rgba(0,0,0,0.50)',
                borderRadius: 99,
                padding: '6px 16px',
              }}
            >
              <span
                key={count}
                aria-hidden="true"
                style={{
                  fontFamily: 'Noto Sans JP', fontWeight: 300, fontSize: 44,
                  color: done ? '#4ade80' : '#fff',
                  lineHeight: 1,
                  display: 'inline-block',
                  animation: 'countPop 0.28s cubic-bezier(0.34,1.56,0.64,1)',
                }}
              >{done ? '✓' : count}</span>
              {!done && (
                <span aria-hidden="true" style={{ fontFamily: 'Noto Sans JP', fontSize: 18, color: 'rgba(255,255,255,0.65)' }}>
                  / 6 枚
                </span>
              )}
            </div>

            {/* Camera label — overlaid bottom-center */}
            <div style={{
              position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)',
              background: 'rgba(0,0,0,0.45)', borderRadius: 99,
              padding: '4px 14px',
              fontFamily: 'Noto Sans JP', fontSize: 11, color: 'rgba(255,255,255,0.85)',
              letterSpacing: '0.06em',
              whiteSpace: 'nowrap',
            }}>真上からのカメラ映像</div>
          </div>
        </div>

        {/* Pip indicators */}
        <div style={{ flexShrink: 0, display: 'flex', gap: 10, justifyContent: 'center', marginTop: 14 }}>
          {[1, 2, 3, 4, 5, 6].map(n => (
            <div key={n} style={{
              width: 44, height: 44, borderRadius: '50%',
              background: n < count
                ? 'var(--color-brand-400)'
                : n === count
                  ? 'var(--color-brand-500)'
                  : 'var(--color-gray-100)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: n <= count ? '#fff' : 'var(--color-ink-300)',
              fontFamily: 'Noto Sans JP', fontSize: 14, fontWeight: 500,
              transition: 'background 0.3s, color 0.3s',
              boxShadow: n === count && !done ? '0 0 0 4px rgba(81,143,204,0.2)' : 'none',
            }}>
              {n < count ? '✓' : n}
            </div>
          ))}
        </div>

      </div>
    </IPad>
  );
}
