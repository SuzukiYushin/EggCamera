import { useState } from 'react';
import { IPad } from '../IPad';
import babyImg from '../../assets/baby.png';
import flameImg from '../../assets/flame.png';

interface PhotoSelectProps {
  onNext: () => void;
}

export function PhotoSelect({ onNext }: PhotoSelectProps) {
  const [sel, setSel] = useState<number | null>(null);

  return (
    <IPad step={5} animKey="photosel">
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '24px 48px 40px', flexShrink: 0 }}>
          <div className="t-eyebrow" style={{ marginBottom: 10 }}>ステップ 5 / 9</div>
          <div className="t-heading" style={{ fontSize: 24 }}>1枚選んでください</div>
          <div className="t-body" style={{ fontSize: 13, marginTop: 4 }}>
            6枚の中からお気に入りを1枚だけ
          </div>
        </div>

        {/* 2×3 grid */}
        <div
          role="radiogroup"
          aria-label="撮影した写真から1枚を選んでください"
          style={{
            flex: 1, padding: '10px 48px',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gridAutoRows: 'auto',
            gap: 10,
            overflowY: 'auto',
            alignContent: 'start',
            minHeight: 0,
          }}
        >
          {[0, 1, 2, 3, 4, 5].map(i => (
            <div
              key={i}
              role="radio"
              aria-checked={sel === i}
              aria-label={`写真 ${i + 1}`}
              tabIndex={0}
              className={`photo-cell${sel === i ? ' selected' : ''}`}
              onClick={() => setSel(i)}
              onKeyDown={e => (e.key === ' ' || e.key === 'Enter') && setSel(i)}
              style={{ background: '#000', aspectRatio: '2/3' }}
            >
              <img
                src={babyImg}
                alt=""
                aria-hidden="true"
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
              {sel === i && <div className="check" aria-hidden="true">✓</div>}
            </div>
          ))}
        </div>

        <div style={{ padding: '14px 48px 32px', flexShrink: 0 }}>
          <button
            className="btn-primary"
            disabled={sel === null}
            onClick={() => sel !== null && onNext()}
          >
            この写真に決める
          </button>
        </div>
      </div>
    </IPad>
  );
}
