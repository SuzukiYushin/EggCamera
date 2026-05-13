import { useState } from 'react';
import { IPad } from '../IPad';
import babyImg from '../../assets/baby.png';

interface CaptureProps {
  onNext: () => void;
}

export function Capture({ onNext }: CaptureProps) {
  const [count, setCount]     = useState(0);
  const [flashKey, setFlashKey] = useState(0);

  const shoot = () => {
    setCount(c => c + 1);
    setFlashKey(k => k + 1);
  };

  return (
    <IPad step={3} totalSteps={7} animKey="capture">
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '12px 32px 20px' }}>

        {/* Header */}
        <div style={{ flexShrink: 0, marginBottom: 10 }}>
          <div className="t-eyebrow" style={{ marginBottom: 4 }}>ステップ 3 / 7</div>
          <div className="t-heading" style={{ fontSize: 20 }}>
            シャッターを押してください
          </div>
        </div>

        {/* Camera view — NO frame overlay */}
        <div style={{
          flex: 1, minHeight: 0,
          display: 'flex', justifyContent: 'center', alignItems: 'center',
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

            {/* Shutter flash */}
            <div key={flashKey} style={{
              position: 'absolute', inset: 0,
              background: flashKey === 0 ? 'transparent' : 'rgba(255,255,255,0)',
              animation: flashKey === 0 ? 'none' : 'shutterFlash 0.3s ease-out',
              pointerEvents: 'none',
            }} />

            {/* Shot counter */}
            {count > 0 && (
              <div style={{
                position: 'absolute', top: 16, left: 16,
                background: 'rgba(0,0,0,0.50)',
                borderRadius: 99, padding: '6px 16px',
                display: 'flex', alignItems: 'baseline', gap: 4,
              }}>
                <span style={{
                  fontFamily: 'Noto Sans JP', fontWeight: 300, fontSize: 36,
                  color: '#fff', lineHeight: 1,
                }}>{count}</span>
                <span style={{ fontFamily: 'Noto Sans JP', fontSize: 14, color: 'rgba(255,255,255,0.65)' }}>
                  枚撮影済み
                </span>
              </div>
            )}

            <div style={{
              position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)',
              background: 'rgba(0,0,0,0.45)', borderRadius: 99, padding: '4px 14px',
              fontFamily: 'Noto Sans JP', fontSize: 11, color: 'rgba(255,255,255,0.85)',
              letterSpacing: '0.06em', whiteSpace: 'nowrap',
            }}>真上からのカメラ映像</div>
          </div>
        </div>

        {/* Shutter button + next */}
        <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
          <button
            onClick={shoot}
            style={{
              height: 68, borderRadius: 12, border: 'none', cursor: 'pointer',
              background: '#fff',
              boxShadow: '0 0 0 2px var(--color-brand-200), 0 4px 16px rgba(81,143,204,0.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'Noto Sans JP', fontSize: 18, fontWeight: 500,
              color: 'var(--color-ink-900)',
              transition: 'transform 0.1s, box-shadow 0.1s',
            }}
            onMouseDown={e => (e.currentTarget.style.transform = 'scale(0.97)')}
            onMouseUp={e => (e.currentTarget.style.transform = 'scale(1)')}
          >
            シャッター
          </button>

          <button
            className="btn-primary"
            disabled={count === 0}
            onClick={onNext}
          >
            {count === 0 ? 'シャッターを押してください' : 'この写真にする'}
          </button>
        </div>

      </div>
    </IPad>
  );
}
