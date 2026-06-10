import { useState } from 'react';
import type { CSSProperties } from 'react';
import { IPad } from '../IPad';
import { useLang } from '../../LangContext';
import babyImg from '../../assets/baby_illustrator.png';

interface CaptureProps {
  onNext: () => void;
}

const MAX_SHOTS = 3;
const SHOT_INTERVAL = 600;

const PARTICLE_COLORS = [
  '#FF6B35', '#FF9E2C', '#FFD166', '#FF5C8D',
  '#FF4E50', '#FFC857', '#FF7B54', '#FFCF5C',
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

let burstCounter = 0;

function makeBurst(): Burst {
  return {
    id: ++burstCounter,
    particles: BASE_ANGLES.map((base, i) => {
      const angle = (base + (Math.random() - 0.5) * 18) * (Math.PI / 180);
      const dist  = 75 + Math.random() * 90;
      return {
        tx: Math.cos(angle) * dist,
        ty: Math.sin(angle) * dist,
        color: PARTICLE_COLORS[i % PARTICLE_COLORS.length],
        size: 10 + Math.random() * 12,
        shape: (['circle', 'square', 'star'] as const)[i % 3],
        duration: 600 + Math.random() * 300,
        delay: Math.random() * 60,
      };
    }),
  };
}

export function Capture({ onNext }: CaptureProps) {
  const { T } = useLang();
  const [count,    setCount]    = useState(0);
  const [flashKey, setFlashKey] = useState(0);
  const [bursts,   setBursts]   = useState<Burst[]>([]);
  const [started,  setStarted]  = useState(false);

  const canShoot = !started && count < MAX_SHOTS;

  const shoot = () => {
    if (!canShoot) return;
    setStarted(true);
    for (let i = 0; i < MAX_SHOTS; i++) {
      setTimeout(() => {
        setCount(c => c + 1);
        setFlashKey(k => k + 1);
        const burst = makeBurst();
        setBursts(b => [...b, burst]);
        setTimeout(() => setBursts(b => b.filter(x => x.id !== burst.id)), 900);
      }, i * SHOT_INTERVAL);
    }
    setTimeout(onNext, (MAX_SHOTS - 1) * SHOT_INTERVAL + 700);
  };

  return (
    <IPad animKey="capture" lightStatus>
      {/* Full-bleed camera view */}
      <div data-section="camera-screen" style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>

        {/* Photo fills entire area */}
        <img
          src={babyImg}
          alt="camera preview"
          style={{
            position: 'absolute', top: '53%', left: '47%',
            transform: 'translate(-49%, -48%)',
            width: '105%', height: '105%', objectFit: 'cover', display: 'block',
          }}
        />

        {/* Instruction text at top */}
        <div style={{
          position: 'absolute', top: 44, left: 0, right: 0,
          textAlign: 'center',
          fontFamily: "var(--font-ui)", fontSize: 18, fontWeight: 700,
          color: '#06236F',
          letterSpacing: '0.1em',
        }}>
          {T.capture.instruction}
        </div>

        {/* Dashed oval face guide */}
        <div style={{
          position: 'absolute',
          top: '13%', left: '50%',
          transform: 'translateX(-50%)',
          width: 185, height: 207,
          borderRadius: '50%',
          border: '6.5px dashed var(--color-brand-500)',
          strokeDasharray: '16.5',
          pointerEvents: 'none',
          opacity: 0.85,
        }} />

        {/* Shutter flash overlay */}
        <div key={flashKey} style={{
          position: 'absolute', inset: 0,
          background: 'rgba(255,255,255,0)',
          animation: flashKey === 0 ? 'none' : 'shutterFlash 0.35s ease-out',
          pointerEvents: 'none',
        }} />

        {/* Particle bursts */}
        {bursts.map(burst => (
          <div key={burst.id} style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
          }}>
            {burst.particles.map((p, i) => <ParticleEl key={i} {...p} />)}
          </div>
        ))}

        {/* Shot counter */}
        {count > 0 && (
          <div style={{
            position: 'absolute', bottom: 116, left: 0, right: 0,
            textAlign: 'center',
            fontFamily: "var(--font-ui)", fontSize: 13, fontWeight: 400,
            color: 'rgba(255,255,255,0.85)',
          }}>{count} / {MAX_SHOTS}</div>
        )}

        {/* Circular shutter button — outer navy ring + inner blue circle with label */}
        <div style={{
          position: 'absolute', bottom: 36, left: '50%',
          transform: 'translateX(-50%)',
        }}>
          <button
            data-ui="shutter-btn"
            onClick={shoot}
            disabled={!canShoot}
            style={{
              width: 76, height: 76,
              borderRadius: '50%',
              border: 'none',
              background: canShoot ? '#06236F' : 'rgba(6,35,111,0.35)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: canShoot ? 'pointer' : 'not-allowed',
              padding: 0,
              boxShadow: canShoot ? '0 4px 24px rgba(81,143,204,0.55)' : 'none',
              transition: 'transform 0.2s ease, box-shadow 0.2s ease, opacity 0.2s',
            }}
          >
            <div style={{
              width: 61, height: 61,
              borderRadius: '50%',
              background: canShoot ? 'var(--color-brand-500)' : 'rgba(81,143,204,0.4)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.2s',
              fontFamily: "var(--font-ui)", fontSize: 18, fontWeight: 500,
              color: '#fff', letterSpacing: '0.1em',
            }}>
              {T.capture.shutter}
            </div>
          </button>
        </div>

      </div>
    </IPad>
  );
}

// ── Particle element ─────────────────────────────────────────────
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
