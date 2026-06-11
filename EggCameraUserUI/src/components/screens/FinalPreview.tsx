import { useState, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { IPad, useFitScale } from '../IPad';
import { Page } from '../Page';
import { useLang } from '../../LangContext';
import frameA from '../../assets/photo_frameA.png';
import frameB from '../../assets/photo_frameB.png';
import frameC from '../../assets/photo_frameC.png';

const FRAME_VARIANTS = [frameA, frameB, frameC];

// Design-space layout constants for the photo box (matches the CSS that used
// to position photo/frame/text — kept here so the canvas can replicate it).
const NAME_TOP_RATIO = 0.58;
const NAME_LEFT_PX = 50;
const NICKNAME_FONT_PX = 50;
const NICKNAME_LINE_HEIGHT = 1.1;
const DAYS_FONT_PX = 28;
const DAYS_LINE_HEIGHT = 1.2;
const TEXT_GAP_PX = 1;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

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
      const dist = 80 + Math.random() * 100;
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
  nickname: string;
  days: number;
  frameLabel: string;
  photoUrl: string;
  onNext: (blob: Blob) => void;
}

export function FinalPreview({ nickname, days, photoUrl, onNext }: FinalPreviewProps) {
  const { T } = useLang();
  const daysText = days > 0 ? T.preview.daysSinceBirth(days) : '';
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [frameSrc] = useState(() => FRAME_VARIANTS[Math.floor(Math.random() * FRAME_VARIANTS.length)]);
  const [ready, setReady] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scale = useFitScale();

  useEffect(() => {
    const t = setTimeout(() => {
      const b = makeBurst();
      setBursts([b]);
      setTimeout(() => setBursts([]), 1100);
    }, 900);
    return () => clearTimeout(t);
  }, []);

  // Composite photo + frame + nickname/days onto the canvas — this is the
  // exact image that gets exported and uploaded on save.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !photoUrl) return;

    let cancelled = false;
    setReady(false);

    (async () => {
      const [photoImg, frameImg] = await Promise.all([loadImage(photoUrl), loadImage(frameSrc)]);
      if (cancelled) return;

      const targetAspect = 2 / 3;
      let cw: number, ch: number;
      if (photoImg.naturalWidth / photoImg.naturalHeight > targetAspect) {
        ch = photoImg.naturalHeight;
        cw = ch * targetAspect;
      } else {
        cw = photoImg.naturalWidth;
        ch = cw / targetAspect;
      }
      cw = Math.round(cw);
      ch = Math.round(ch);
      canvas.width = cw;
      canvas.height = ch;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Photo, center-cropped to 2:3 (object-fit: cover)
      const sx = (photoImg.naturalWidth - cw) / 2;
      const sy = (photoImg.naturalHeight - ch) / 2;
      ctx.drawImage(photoImg, sx, sy, cw, ch, 0, 0, cw, ch);

      // Frame, stretched to fill (object-fit: fill)
      ctx.drawImage(frameImg, 0, 0, cw, ch);

      if (nickname || daysText) {
        const rect = container.getBoundingClientRect();
        const containerWidthDesign = rect.width / scale;
        const k = cw / containerWidthDesign;
        const x = NAME_LEFT_PX * k;
        let y = ch * NAME_TOP_RATIO;

        ctx.textBaseline = 'top';

        if (nickname) {
          const fontSize = NICKNAME_FONT_PX * k;
          const family = cssVar('--font-heading');
          await document.fonts.load(`900 ${fontSize}px ${family}`).catch(() => {});
          ctx.font = `900 ${fontSize}px ${family}`;
          ctx.lineWidth = 2 * k;
          ctx.strokeStyle = '#000000';
          ctx.fillStyle = '#000000';
          try { ctx.letterSpacing = `${-0.01 * fontSize}px`; } catch { /* unsupported */ }
          ctx.strokeText(nickname, x, y);
          ctx.fillText(nickname, x, y);
          y += fontSize * NICKNAME_LINE_HEIGHT + TEXT_GAP_PX * k;
        }

        if (daysText) {
          const fontSize = DAYS_FONT_PX * k;
          const family = cssVar('--font-futura');
          await document.fonts.load(`600 ${fontSize}px ${family}`).catch(() => {});
          ctx.font = `600 ${fontSize}px ${family}`;
          ctx.lineWidth = 0.6 * k;
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.95)';
          ctx.fillStyle = 'rgba(0, 0, 0, 0.95)';
          try { ctx.letterSpacing = `${0.01 * fontSize}px`; } catch { /* unsupported */ }
          for (const line of daysText.split('\n')) {
            ctx.strokeText(line, x, y);
            ctx.fillText(line, x, y);
            y += fontSize * DAYS_LINE_HEIGHT;
          }
        }
      }

      if (!cancelled) setReady(true);
    })();

    return () => { cancelled = true; };
  }, [photoUrl, frameSrc, nickname, daysText, scale]);

  const handleSave = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob(blob => {
      if (blob) onNext(blob);
    }, 'image/png');
  };

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

          <div ref={containerRef} style={{
            position: 'relative',
            aspectRatio: '2/3',
            height: '90%',
            borderRadius: 4,
            overflow: 'hidden',
            border: 'none',
            animation: 'cameraGlow 4.4s ease-in-out infinite',
          }}>
            <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
          </div>
        </div>

        <div style={{ flexShrink: 0, marginTop: 14 }}>
          <button className="btn-primary" onClick={handleSave} disabled={!ready}>{T.preview.save}</button>
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
