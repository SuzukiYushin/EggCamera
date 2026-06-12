import { useState, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { IPad } from '../IPad';
import { useLang } from '../../LangContext';
import { capturePhoto, ApiError } from '../../api';
import type { SessionPhoto } from '../../api';
import { reportClientError } from '../../clientLog';
import babyImg from '../../assets/baby_illustrator.png';

interface CaptureProps {
  sessionId: string | null;
  onComplete: (photos: SessionPhoto[]) => void;
  onError: () => void;
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
      const dist = 225 + Math.random() * 270;
      return {
        tx: Math.cos(angle) * dist,
        ty: Math.sin(angle) * dist,
        color: PARTICLE_COLORS[i % PARTICLE_COLORS.length],
        size: 30 + Math.random() * 36,
        shape: (['circle', 'square', 'star'] as const)[i % 3],
        duration: 600 + Math.random() * 300,
        delay: Math.random() * 60,
      };
    }),
  };
}

// ── iPhoneのリアルタイム映像（約8fpsでフレームをポーリング） ──────
// 取得できない間は同梱イラストにフォールバックし、自動で再接続を試みる。
const PREVIEW_INTERVAL_MS = 125;
const PREVIEW_RETRY_MS = 1500;

function LiveCameraView() {
  const [frameUrl, setFrameUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let prevUrl: string | null = null;
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    (async () => {
      while (!cancelled) {
        const t0 = Date.now();
        try {
          const res = await fetch('/api/preview/frame', { cache: 'no-store' });
          if (!res.ok) throw new Error(`status ${res.status}`);
          const blob = await res.blob();
          if (cancelled) break;
          const url = URL.createObjectURL(blob);
          setFrameUrl(url);
          if (prevUrl) URL.revokeObjectURL(prevUrl);
          prevUrl = url;
          await sleep(Math.max(0, PREVIEW_INTERVAL_MS - (Date.now() - t0)));
        } catch {
          if (cancelled) break;
          setFrameUrl(null); // イラストにフォールバック
          await sleep(PREVIEW_RETRY_MS);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (prevUrl) URL.revokeObjectURL(prevUrl);
    };
  }, []);

  if (frameUrl) {
    return (
      <img
        src={frameUrl}
        alt="camera preview"
        style={{
          position: 'absolute', inset: 0,
          width: '100%', height: '100%',
          objectFit: 'cover', display: 'block',
        }}
      />
    );
  }

  // フォールバック（iPhone未接続・プレビュー取得失敗時）
  return (
    <img
      src={babyImg}
      alt="camera preview"
      style={{
        position: 'absolute', top: '45%', left: '47%',
        transform: 'translate(-49%, -48%)',
        width: '105%', height: '105%', objectFit: 'cover', display: 'block',
      }}
    />
  );
}

export function Capture({ sessionId, onComplete, onError }: CaptureProps) {
  const { T } = useLang();
  const [photos, setPhotos] = useState<SessionPhoto[]>([]);
  const [flashKey, setFlashKey] = useState(0);
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [started, setStarted] = useState(false);

  const canShoot = !!sessionId && !started && photos.length < MAX_SHOTS;

  // iPhoneのシャッターはトリガー送信の直後に切れる（レスポンスはHEIC転送・変換後で
  // 数秒遅れる）ので、エフェクトは完了を待たず送信直後+補正分の遅延で発火させる
  const FX_DELAY_MS = 400;

  const fireShotEffect = () => {
    setFlashKey(k => k + 1);
    const burst = makeBurst();
    setBursts(b => [...b, burst]);
    setTimeout(() => setBursts(b => b.filter(x => x.id !== burst.id)), 900);
  };

  const shoot = async () => {
    if (!canShoot || !sessionId) return;
    setStarted(true);

    const acc = [...photos];
    while (acc.length < MAX_SHOTS) {
      const fxTimer = setTimeout(fireShotEffect, FX_DELAY_MS);
      try {
        const photo = await capturePhoto(sessionId);
        acc.push(photo);
        setPhotos([...acc]);
        if (acc.length < MAX_SHOTS) {
          await new Promise(r => setTimeout(r, SHOT_INTERVAL));
        }
      } catch (err) {
        clearTimeout(fxTimer); // 失敗時はエフェクトを出さない（即時エラーの場合）
        // 撮影エラーは全画面共通のお詫びオーバーレイへ（自動リロードで復帰）
        const code = err instanceof ApiError ? err.code : 'capture_failed';
        reportClientError(`capture failed: ${code} (shot ${acc.length + 1}/3)`);
        onError();
        return;
      }
    }
    setTimeout(() => onComplete(acc), 700);
  };

  const shutterLabel = started ? T.capture.capturing : T.capture.shutter;

  return (
    <IPad animKey="capture">
      {/* Full-bleed camera view */}
      <div data-section="camera-screen" style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>

        {/* iPhoneのリアルタイム映像（未接続時はイラストにフォールバック） */}
        <LiveCameraView />

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
        {photos.length > 0 && (
          <div style={{
            position: 'absolute', bottom: 116, left: 0, right: 0,
            textAlign: 'center',
            fontFamily: "var(--font-ui)", fontSize: 15, fontWeight: 600,
            color: '#FF3B30',
          }}>{photos.length} / {MAX_SHOTS}</div>
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
              fontFamily: "var(--font-ui)", fontSize: 14, fontWeight: 500,
              color: '#fff', letterSpacing: '0.06em',
              textAlign: 'center', whiteSpace: 'pre-line', lineHeight: 1.25,
            }}>
              {shutterLabel}
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
