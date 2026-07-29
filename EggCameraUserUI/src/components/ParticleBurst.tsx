import type { CSSProperties } from 'react';

// 撮影・プレビュー画面で共有する花火パーティクル。
// 旧来は両画面に同一コードが重複していたのを集約し、差分（色・サイズ・距離）を
// オプション化した。

export interface Particle {
  tx: number; ty: number;
  color: string; size: number;
  shape: 'circle' | 'square' | 'star';
  duration: number; delay: number;
}

export interface Burst {
  id: number;
  particles: Particle[];
}

export interface BurstOptions {
  colors: string[];
  /** パーティクル数（既定16） */
  count?: number;
  /** 飛距離 [最小, 追加ランダム幅] */
  dist?: [number, number];
  /** サイズ [最小, 追加ランダム幅] */
  size?: [number, number];
  /** アニメ時間ms [最小, 追加ランダム幅] */
  duration?: [number, number];
  /** 開始ディレイの最大ms */
  delayMax?: number;
  /** 射出角のばらつき（度） */
  jitterDeg?: number;
}

// 設計キャンバス(768×1024)は cover で必ず画面全体を覆うので、キャンバス基準＝画面基準になる。
// 中心から四隅までの距離＝ここまで飛ばせばエフェクトが画面いっぱいに広がる。
// 実寸ピクセルを直接書かず、この値の比率で指定すること（解像度・端末が変わっても追従する）。
export const CANVAS_W = 768;
export const CANVAS_H = 1024;
export const CANVAS_REACH = Math.round(Math.hypot(CANVAS_W / 2, CANVAS_H / 2)); // = 640

let burstCounter = 0;

export function makeBurst(opts: BurstOptions): Burst {
  const {
    colors,
    count = 16,
    dist = [80, 100],
    size = [10, 12],
    duration = [600, 300],
    delayMax = 80,
    jitterDeg = 20,
  } = opts;

  const baseAngles = Array.from({ length: count }, (_, i) => (360 / count) * i);

  return {
    id: ++burstCounter,
    particles: baseAngles.map((base, i) => {
      const angle = (base + (Math.random() - 0.5) * jitterDeg) * (Math.PI / 180);
      const d = dist[0] + Math.random() * dist[1];
      return {
        tx: Math.cos(angle) * d,
        ty: Math.sin(angle) * d,
        color: colors[i % colors.length],
        size: size[0] + Math.random() * size[1],
        shape: (['circle', 'square', 'star'] as const)[i % 3],
        duration: duration[0] + Math.random() * duration[1],
        delay: Math.random() * delayMax,
      };
    }),
  };
}

export function ParticleEl({ tx, ty, color, size, shape, duration, delay }: Particle) {
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
