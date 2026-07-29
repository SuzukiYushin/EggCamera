import { useSyncExternalStore } from 'react';
import { PROTO } from '../api';

const DESIGN_WIDTH = 768;
const DESIGN_HEIGHT = 1024;

// ── 実ビューポート寸法の共有ストア ──────────────────────────────────
// キャンバスを切り取る箱(.app-viewport = position:fixed/inset:0)そのものを実測する。
// window.innerWidth/Height を使わないのは、ホーム画面追加(standalone)の iOS が実画面
// より小さい値を返し、かつ起動後に resize を飛ばさないため——スケール基準とクリップ枠が
// ずれてキャンバス下に body 背景の白帯が残る。箱を直接測ればこの二つは定義上一致する。
let snapshot = { w: window.innerWidth, h: window.innerHeight };
const listeners = new Set<() => void>();
let observer: ResizeObserver | null = null;

function measure() {
  const rect = document.querySelector('.app-viewport')?.getBoundingClientRect();
  const w = rect?.width || window.innerWidth;
  const h = rect?.height || window.innerHeight;
  if (w === snapshot.w && h === snapshot.h) return;
  snapshot = { w, h };
  listeners.forEach(fn => fn());
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  if (listeners.size === 1) {
    const el = document.querySelector('.app-viewport');
    // ResizeObserver は standalone 起動直後の「遅れてくる正しい高さ」も拾う
    if (el && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(el);
    }
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    measure();
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    }
  };
}

const getSnapshot = () => snapshot;

// 実際に表示されているビューポート(=キャンバスを切り取る箱)の実寸。
export function useViewportSize() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Scales the fixed-size (768×1024) design canvas to fit the real device viewport.
//
// 本番: cover(= Math.max) でスケールし、はみ出しは .app-viewport(overflow:hidden) で
// 切り取る。これで実機/ウィンドウのアスペクト比が何であっても——横長でも縦長でも、
// 3:4 からどれだけずれても——左右/上下の余白(レターボックス)が一切出ず、常にフル
// ブリードになる。本番の 3:4 実機ではぴったり全画面のまま(はみ出し量ほぼ0)。極端な
// アスペクト比では周辺が切り取られるが、「どんなウィンドウでも余白を出さない」方針を
// 優先する。
//
// プロト(クライアント確認)表示だけは iPad の画面枠と選択ナビを見せたいので、従来どおり
// 全体が収まる contain(min) を維持する。プロトの箱は CSS(top:64px)で既にナビぶん縮んで
// いるので、ここでオフセットを引く必要はない。
export function useFitScale() {
  const { w, h } = useViewportSize();
  const wScale = w / DESIGN_WIDTH;
  const hScale = h / DESIGN_HEIGHT;
  return PROTO ? Math.min(wScale, hScale) : Math.max(wScale, hScale);
}
