import { useState } from 'react';
import { IPad } from '../IPad';
import { useLang } from '../../LangContext';
import babyA from '../../assets/baby_a.png';
import babyB from '../../assets/baby_b.png';
import babyC from '../../assets/baby_c.png';

interface PhotoSelectProps {
  onNext: () => void;
  onBack: () => void;
}

const PHOTOS = [babyA, babyB, babyC];

export function PhotoSelect({ onNext, onBack }: PhotoSelectProps) {
  const { T } = useLang();
  const [sel, setSel] = useState<number | null>(1);

  return (
    <IPad step={4} totalSteps={7} animKey="photosel">
      <div data-section="photoselect-screen" style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        padding: '50px 40px 40px',
      }}>

        {/* Step */}
        <div className="t-eyebrow" style={{ marginBottom: 170, marginLeft: 0 }}>{T.photoselect.step}</div>

        {/* Heading */}
        <div className="t-heading" style={{ textAlign: 'center', marginBottom: -50 }}>
          {T.photoselect.heading}
        </div>

        {/* 3 photos in a row */}
        <div
          role="radiogroup"
          aria-label="写真を1枚選んでください"
          style={{
            flex: 1,
            display: 'flex',
            gap: 16,
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 0,
          }}
        >
          {PHOTOS.map((src, i) => (
            <div
              key={i}
              role="radio"
              aria-checked={sel === i}
              aria-label={`写真 ${i + 1}`}
              tabIndex={0}
              onClick={() => setSel(i)}
              onKeyDown={e => (e.key === ' ' || e.key === 'Enter') && setSel(i)}
              style={{
                flex: 1,
                aspectRatio: '2/3',
                maxHeight: '100%',
                borderRadius: 8,
                overflow: 'hidden',
                cursor: 'pointer',
                position: 'relative',
                border: sel === i
                  ? '9.5px solid var(--color-brand-500)'
                  : '9.5px solid transparent',
                boxShadow: sel === i
                  ? 'none'
                  : '0 2px 12px rgba(0,0,0,0.12)',
                transition: 'border-color 0.15s, box-shadow 0.15s',
              }}
            >
              <img
                src={src}
                alt=""
                aria-hidden="true"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            </div>
          ))}
        </div>

        {/* Decide button */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 32 }}>
          <button
            className="btn-primary"
            disabled={sel === null}
            onClick={() => sel !== null && onNext()}
          >
            {T.photoselect.decide}
          </button>
          <button className="btn-ghost" onClick={onBack}>
            {T.photoselect.back}
          </button>
        </div>

      </div>
    </IPad>
  );
}
