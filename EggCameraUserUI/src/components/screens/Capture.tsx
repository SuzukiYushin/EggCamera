import { useState } from 'react';
import { IPad } from '../IPad';
import { useLang } from '../../LangContext';
import babyImg from '../../assets/baby.png';

interface CaptureProps {
  onNext: () => void;
}

const MAX_SHOTS = 3;

export function Capture({ onNext }: CaptureProps) {
  const { T } = useLang();
  const [count, setCount]       = useState(0);
  const [flashKey, setFlashKey] = useState(0);

  const canShoot = count < MAX_SHOTS;
  const hasShot  = count > 0;

  const shoot = () => {
    if (!canShoot) return;
    setCount(c => c + 1);
    setFlashKey(k => k + 1);
  };

  return (
    <IPad step={3} totalSteps={7} animKey="capture">
      <div data-section="camera-screen" style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        overflow: 'hidden', padding: '12px 32px 20px',
      }}>

        {/* Camera view */}
        <div data-ui="camera-view" style={{
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
              alt="camera preview"
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />

            {/* Shutter flash */}
            <div key={flashKey} style={{
              position: 'absolute', inset: 0,
              background: 'rgba(255,255,255,0)',
              animation: flashKey === 0 ? 'none' : 'shutterFlash 0.3s ease-out',
              pointerEvents: 'none',
            }} />
          </div>
        </div>

        {/* Controls */}
        <div data-ui="camera-controls" style={{
          flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16,
        }}>
          {/* Shot limit info */}
          <div className="t-caption" style={{ textAlign: 'center', letterSpacing: '0.04em' }}>
            {T.capture.shotLimit}
          </div>

          {/* Shot counter */}
          {hasShot && (
            <div style={{
              textAlign: 'center',
              fontFamily: 'Noto Sans JP', fontSize: 12, color: 'var(--color-ink-300)',
            }}>
              {count} / {MAX_SHOTS}
            </div>
          )}

          <button
            data-ui="shutter-btn"
            onClick={shoot}
            disabled={!canShoot}
            style={{
              height: 68, borderRadius: 12, border: 'none',
              cursor: canShoot ? 'pointer' : 'not-allowed',
              background: canShoot ? '#fff' : 'var(--color-gray-100)',
              boxShadow: canShoot ? '0 0 0 2px var(--color-brand-200), 0 4px 16px rgba(81,143,204,0.2)' : 'none',
              fontFamily: 'Noto Sans JP', fontSize: 18, fontWeight: 500,
              color: canShoot ? 'var(--color-ink-900)' : 'var(--color-ink-300)',
              transition: 'transform 0.1s, box-shadow 0.1s, background 0.2s',
              opacity: canShoot ? 1 : 0.5,
            }}
            onMouseDown={e => { if (canShoot) e.currentTarget.style.transform = 'scale(0.97)'; }}
            onMouseUp={e => (e.currentTarget.style.transform = 'scale(1)')}
          >
            {!canShoot ? T.capture.maxReached : hasShot ? T.capture.retake : T.capture.shutter}
          </button>

          <button
            data-ui="decide-btn"
            className="btn-primary"
            disabled={!hasShot}
            onClick={onNext}
          >
            {hasShot ? T.capture.decide : T.capture.decideDisabled}
          </button>
        </div>
      </div>
    </IPad>
  );
}
