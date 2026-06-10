import { useState } from 'react';
import { IPad } from '../IPad';
import { FRAMES } from '../../data/frames';
import flameImg from '../../assets/flame.png';

interface FrameSelectionProps {
  onNext: () => void;
  onBack?: () => void;
}

export function FrameSelection({ onNext, onBack }: FrameSelectionProps) {
  const [selectedId, setSelectedId] = useState(FRAMES[0].id);
  const sel = FRAMES.find(f => f.id === selectedId)!;

  return (
    <IPad step={3} animKey="frame">
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '50px 48px 0', flexShrink: 0 }}>
          <div className="t-eyebrow" style={{ marginBottom: 50 }}>ステップ 3 / 9</div>
          <div className="t-heading" style={{ fontSize: 22, marginBottom: 30 }}>フレームを選んでください</div>
        </div>

        {/* Main content: preview + grid */}
        <div style={{
          flex: 1,
          display: 'flex',
          gap: 20,
          padding: '16px 48px 0',
          overflow: 'hidden',
          minHeight: 0,
        }}>

          {/* Left: large preview */}
          <div style={{
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
          }}>
            <div style={{
              width: 224,
              aspectRatio: '2/3',
              borderRadius: 6,
              overflow: 'hidden',
              border: '2.5px solid var(--color-brand-500)',
              boxShadow: '0 8px 32px rgba(81,143,204,0.25)',
              background: 'var(--color-gray-50)',
              position: 'relative',
            }}>
              <img
                key={selectedId}
                src={flameImg}
                alt={sel.label}
                style={{
                  position: 'absolute', inset: 0,
                  width: '100%', height: '100%', objectFit: 'fill',
                  display: 'block', pointerEvents: 'none',
                  animation: 'frameSwitch 0.18s ease',
                }}
              />
            </div>
            <div style={{
              background: 'var(--color-brand-500)',
              color: '#fff',
              borderRadius: 4,
              padding: '7px 24px',
              fontFamily: "var(--font-ui)",
              fontSize: 13,
              fontWeight: 500,
              letterSpacing: '0.06em',
              minWidth: 100,
              textAlign: 'center',
            }}>
              {sel.label}
            </div>
          </div>

          {/* Right: 3-column scrollable grid */}
          <div
            role="radiogroup"
            aria-label="フレームを選んでください"
            className="frame-grid"
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 10,
              alignContent: 'start',
              paddingRight: 8,
              paddingBottom: 8,
            }}
          >
            {FRAMES.map(f => {
              const isSelected = f.id === selectedId;
              return (
                <div
                  key={f.id}
                  role="radio"
                  aria-checked={isSelected}
                  aria-label={f.label}
                  tabIndex={0}
                  onClick={() => setSelectedId(f.id)}
                  onKeyDown={e => (e.key === ' ' || e.key === 'Enter') && setSelectedId(f.id)}
                  style={{
                    cursor: 'pointer',
                    borderRadius: 4,
                    overflow: 'clip',
                    border: `2px solid ${isSelected ? 'var(--color-brand-500)' : 'var(--color-gray-200)'}`,
                    boxShadow: isSelected
                      ? '0 0 0 3px rgba(81,143,204,0.2), 0 2px 8px rgba(0,0,0,0.08)'
                      : '0 1px 4px rgba(0,0,0,0.06)',
                    transform: isSelected ? 'scale(1.03)' : 'scale(1)',
                    transition: 'transform 0.15s cubic-bezier(0.4,0,0.2,1), border-color 0.15s, box-shadow 0.15s',
                    position: 'relative',
                    background: 'var(--color-gray-50)',
                  }}
                >
                  <div style={{
                    position: 'relative' ,
                      width: '100%', paddingTop: '150%',
                    }}>
                    <img
                      src={flameImg}
                      alt=""
                      aria-hidden="true"
                      style={{
                        position: 'absolute', inset: 0,
                        width: '100%', height: '100%', objectFit: 'fill',
                        display: 'block', pointerEvents: 'none',
                      }}
                    />
                  </div>
                  <div style={{
                    padding: '5px 4px',
                    textAlign: 'center',
                    fontFamily: "var(--font-ui)",
                    fontSize: 12,
                    color: isSelected ? 'var(--color-brand-700)' : 'var(--color-ink-500)',
                    fontWeight: isSelected ? 600 : 400,
                    background: isSelected ? 'var(--color-brand-50)' : '#fff',
                    borderTop: `1px solid ${isSelected ? 'var(--color-brand-100)' : 'var(--color-gray-100)'}`,
                    transition: 'color 0.15s, background 0.15s, border-color 0.15s',
                  }}>
                    {f.label}
                  </div>
                  {isSelected && (
                    <div style={{
                      position: 'absolute', top: 6, right: 6,
                      width: 20, height: 20, borderRadius: '50%',
                      background: 'var(--color-brand-500)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#fff', fontSize: 10, fontWeight: 700,
                      boxShadow: '0 1px 4px rgba(81,143,204,0.5)',
                    }}>✓</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* CTA */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 48px 32px', flexShrink: 0 }}>
          <button className="btn-primary" onClick={onNext}>
            このフレームで撮影する
          </button>
          <button className="btn-ghost" onClick={onBack}>
            戻る
          </button>
        </div>
      </div>
    </IPad>
  );
}
