import { useState, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { IPad } from '../IPad';
import { Page } from '../Page';
import { useLang } from '../../LangContext';
import frameImg from '../../assets/photo_frame.png';

const BURST_COLORS = [
  '#FFD700', '#FF6B35', '#FF9E2C', '#FF5C8D',
  '#FFC857', '#FF7B54', '#FF4E50', '#FFCF5C',
  '#FF8C42', '#FF3E7F', '#FFB300', '#FF6F61',
];

const BASE_ANGLES = Array.from({ length: 16 }, (_, i) => (360 / 16) * i);

interface Burst {
  id: number;
  particles: {
    tx: number; ty: number;
    color: string; size: number;
    shape: 'circle' | 'square' | 'star';
    duration: number; delay: number;
  }[];
}

let burstId = 0;

function makeBurst(): Burst {
  return {
    id: ++burstId,
    particles: BASE_ANGLES.map((base, i) => {
      const angle = (base + (Math.random() - 0.5) * 20) * (Math.PI / 180);
      const dist  = 80 + Math.random() * 100;
      return {
        tx: Math.cos(angle) * dist,
        ty: Math.sin(angle) * dist,
        color: BURST_COLORS[i % BURST_COLORS.length],
        size: 10 + Math.random() * 12,
        shape: (['circle', 'square', 'star'] as const)[i % 3],
        duration: 650 + Math.random() * 300,
        delay: Math.random() * 80,
      };
    }),
  };
}

interface FinalPreviewProps {
  nickname:   string;
  days:       number;
  frameLabel: string;
  photoUrl:   string;
  onNext: () => void;
}

export function FinalPreview({ nickname, days, photoUrl, onNext }: FinalPreviewProps) {
  const { T } = useLang();
  const daysText = days > 0 ? T.preview.daysSinceBirth(days) : '';
  const [bursts, setBursts] = useState<Burst[]>([]);

  useEffect(() => {
    const t = setTimeout(() => {
      const b = makeBurst();
      setBursts([b]);
      setTimeout(() => setBursts([]), 1100);
    }, 900);
    return () => clearTimeout(t);
  }, []);

  return (
    <IPad step={5} totalSteps={7} animKey="preview">
      <Page data-section="preview-screen" style={{ paddingTop: 50, paddingBottom: 28 }}>

        {/* Header */}
        <div data-ui="preview-header" style={{ marginBottom: 0, flexShrink: 0, textAlign: 'center' }}>
          <div className="t-eyebrow" style={{ marginBottom: 40, marginLeft: 0, textAlign: 'left' }}>{T.preview.step}</div>
          <div className="t-heading" style={{ display: 'inline-block', marginBottom: 0, animation: 'countPop 0.6s cubic-bezier(0.22, 1, 0.36, 1) 0.3s both' }}>
            {T.preview.heading}
          </div>
        </div>

        {/* Photo composite */}
        <div data-ui="photo-composite" style={{
          flex: 1, minHeight: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32,
          position: 'relative',
        }}>
          {/* Particle burst */}
          {bursts.map(burst => (
            <div key={burst.id} style={{
              position: 'absolute',
              top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none', zIndex: 10,
            }}>
              {burst.particles.map((p, i) => <ParticleEl key={i} {...p} />)}
            </div>
          ))}

          <div style={{
            position: 'relative',
            aspectRatio: '2/3',
            height: '90%',
            borderRadius: 4,
            overflow: 'hidden',
            border: 'none',
            animation: 'cameraGlow 4.4s ease-in-out infinite',
          }}>
            <img src={photoUrl} alt="photo"
              style={{
                position: 'absolute', top: '50%', left: '50%',
                transform: 'translate(-52%, -30%)',
                width: '200%', height: '200%', objectFit: 'cover', display: 'block',
              }} />
            <img src={frameImg} alt="frame overlay"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill', display: 'block', pointerEvents: 'none' }} />

            {(nickname || daysText) && (
              <div data-ui="name-badge" style={{
                position: 'absolute', top: '58%', left: 50, right: 0,
                display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1,
                pointerEvents: 'none',
              }}>
                {nickname && (
                  <div style={{
                    fontFamily: 'var(--font-heading)',
                    fontSize: 50, fontWeight: 900,
                    letterSpacing: '-0.01em',
                    color: '#000000',
                    lineHeight: 1.1,
                    textAlign: 'left',
                    WebkitTextStroke: '2px currentColor',
                  }}>{nickname}</div>
                )}
                {daysText && (
                  <div style={{
                    fontFamily: 'var(--font-futura)',
                    fontSize: 28, fontWeight: 600,
                    letterSpacing: '0.01em',
                    color: 'rgba(0, 0, 0, 0.95)',
                    lineHeight: 1.2,
                    textAlign: 'left',
                    whiteSpace: 'pre-line',
                    WebkitTextStroke: '0.6px currentColor',
                  }}>{daysText}</div>
                )}
              </div>
            )}
          </div>
        </div>

        <div style={{ flexShrink: 0, marginTop: 14 }}>
          <button className="btn-primary" onClick={onNext}>{T.preview.save}</button>
        </div>
      </Page>
    </IPad>
  );
}

// ── Particle element ──────────────────────────────────────────────
interface ParticleProps {
  tx: number; ty: number;
  color: string; size: number;
  shape: 'circle' | 'square' | 'star';
  duration: number; delay: number;
}

function ParticleEl({ tx, ty, color, size, shape, duration, delay }: ParticleProps) {
  const base: CSSProperties = {
    position: 'absolute',
    width: size, height: size,
    background: color,
    animation: `particleFly ${duration}ms ease-out forwards`,
    animationDelay: `${delay}ms`,
    opacity: 0,
    ['--tx' as string]: `${tx}px`,
    ['--ty' as string]: `${ty}px`,
  };

  if (shape === 'circle') return <span style={{ ...base, borderRadius: '50%' }} />;
  if (shape === 'square') return <span style={{ ...base, borderRadius: 3, transform: 'rotate(45deg)' }} />;
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" style={{
      position: 'absolute',
      animation: `particleFly ${duration}ms ease-out forwards`,
      animationDelay: `${delay}ms`,
      opacity: 0,
      ['--tx' as string]: `${tx}px`,
      ['--ty' as string]: `${ty}px`,
    }}>
      <path d="M10 1 L11.4 8.6 L19 10 L11.4 11.4 L10 19 L8.6 11.4 L1 10 L8.6 8.6 Z" fill={color} />
    </svg>
  );
}
