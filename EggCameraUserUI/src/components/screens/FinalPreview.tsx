import { useState, useEffect, useRef } from 'react';
import { IPad, useFitScale } from '../IPad';
import { Page } from '../Page';
import { useLang } from '../../LangContext';
import { getFrames, getGrowthFrames, getCropSettings } from '../../api';
import type { CropSettings } from '../../api';
import { ParticleEl, makeBurst, type Burst } from '../ParticleBurst';
import { reportClientError } from '../../clientLog';
import frameA from '../../assets/photo_frameA.png';
import frameB from '../../assets/photo_frameB.png';
import frameC from '../../assets/photo_frameC.png';

// 管理画面のフレームAPIが空/失敗のときに使う同梱フォールバック
const FRAME_FALLBACKS = [frameA, frameB, frameC];

const DEFAULT_CROP: CropSettings = { zoom: 1, offsetX: 0, offsetY: 0 };

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

const previewBurst = () => makeBurst({
  colors: BURST_COLORS,
  dist: [80, 100], size: [10, 12], duration: [650, 300], delayMax: 80, jitterDeg: 20,
});

interface FinalPreviewProps {
  nickname: string;
  days: number;
  photoUrl: string;
  onNext: (blob: Blob) => void;
}

export function FinalPreview({ nickname, days, photoUrl, onNext }: FinalPreviewProps) {
  const { T } = useLang();
  const daysText = days > 0 ? T.preview.daysSinceBirth(days) : '';
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState<CropSettings>(DEFAULT_CROP);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scale = useFitScale();

  useEffect(() => {
    const t = setTimeout(() => {
      const b = previewBurst();
      setBursts([b]);
      setTimeout(() => setBursts([]), 1100);
    }, 900);
    return () => clearTimeout(t);
  }, []);

  // フレーム選択（マウント時に一度だけ）。
  //  ①「成長するファミちゃん（年齢連動）」が有効なら days で該当フレームを決定的に選ぶ。
  //    （レアはサーバ側の低確率抽選＝完成画像でのお楽しみとし、プレビューは年齢フレームを表示）
  //  ② 無効/失敗なら従来どおり登録フレームからランダム、それも空なら同梱フォールバック。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const g = await getGrowthFrames();
        if (cancelled) return;
        if (g.enabled && g.growth.length > 0) {
          const sorted = [...g.growth].sort((a, b) => (a.minDays ?? 0) - (b.minDays ?? 0));
          let chosen = sorted[0];
          for (const f of sorted) if (days >= (f.minDays ?? 0)) chosen = f;
          setFrameSrc(chosen.url);
          try {
            const s = await getCropSettings();
            if (!cancelled && s?.crop) setCrop(s.crop);
          } catch { /* デフォルトのまま */ }
          return;
        }
      } catch { /* 無効/失敗なら従来のランダムへ */ }

      try {
        const frames = await getFrames();
        if (cancelled) return;
        if (frames.length > 0) {
          setFrameSrc(frames[Math.floor(Math.random() * frames.length)].url);
        } else {
          setFrameSrc(FRAME_FALLBACKS[Math.floor(Math.random() * FRAME_FALLBACKS.length)]);
        }
      } catch {
        if (!cancelled) setFrameSrc(FRAME_FALLBACKS[Math.floor(Math.random() * FRAME_FALLBACKS.length)]);
      }
      try {
        const s = await getCropSettings();
        if (!cancelled && s?.crop) setCrop(s.crop);
      } catch { /* デフォルトのまま */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Composite photo + frame + nickname/days onto the canvas — this is the
  // exact image that gets exported and uploaded on save.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !photoUrl || !frameSrc) return;

    let cancelled = false;
    setReady(false);

    (async () => {
      const [photoImg, frameImg] = await Promise.all([loadImage(photoUrl), loadImage(frameSrc)]);
      if (cancelled) return;

      // 完成画像は iPhone 画面比(2768:6000)。compose.js の TARGET_ASPECT と揃える。
      const targetAspect = 2768 / 6000;
      const iw = photoImg.naturalWidth;
      const ih = photoImg.naturalHeight;
      let cw: number, ch: number;
      if (iw / ih > targetAspect) {
        ch = ih;
        cw = ch * targetAspect;
      } else {
        cw = iw;
        ch = cw / targetAspect;
      }
      cw = Math.round(cw);
      ch = Math.round(ch);
      canvas.width = cw;
      canvas.height = ch;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Photo: 2:3 center-crop (object-fit: cover) に offset(pan) を適用。
      // ズームは撮影時にカメラ(センサークロップ)で適用済みのため、ここではデジタルズーム=1。
      // 二重ズーム防止・サーバ合成(compose.js)と整合（この旧canvasパスは serverCompose=false 時のみ）。
      const rw = cw;
      const rh = ch;
      let rx = (iw - cw) / 2 + (crop.offsetX / 100) * rw;
      let ry = (ih - ch) / 2 + (crop.offsetY / 100) * rh;
      rx = Math.max(0, Math.min(rx, iw - rw));
      ry = Math.max(0, Math.min(ry, ih - rh));
      ctx.drawImage(photoImg, rx, ry, rw, rh, 0, 0, cw, ch);

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
  }, [photoUrl, frameSrc, crop, nickname, daysText, scale]);

  const exportCanvas = (canvas: HTMLCanvasElement): Promise<Blob | null> =>
    // PNGだと写真によっては20MB超になりアップロードが413で失敗するためJPEGで書き出す
    // （サーバ側でも最終的にJPEG q95 に変換しているので品質影響なし）。
    new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));

  const handleSave = async () => {
    const canvas = canvasRef.current;
    if (!canvas || saving) return;
    setSaving(true);
    setExportFailed(false);

    // iPad Safari は高解像度canvas（48MP写真→約4032x6048≒24Mpx, RGBA約97MB）の
    // JPEGエンコードでメモリ圧により toBlob が null を返すことがある。これを握りつぶすと
    // 決定タップ後に onNext（アップロード）が一切呼ばれず、合成・QR遷移しないまま固まる。
    // 無音にせず数回バックオフ・リトライ（メモリ回復待ち）し、それでも駄目ならサーバへ
    // 記録してユーザーに再試行を促す。
    for (let attempt = 1; attempt <= 4; attempt++) {
      const blob = await exportCanvas(canvas);
      if (blob) { onNext(blob); return; }
      reportClientError(
        `canvas.toBlob returned null (attempt ${attempt}/4, ${canvas.width}x${canvas.height})`,
      );
      await new Promise(r => setTimeout(r, 250 * attempt));
    }
    setSaving(false);
    setExportFailed(true);
  };

  return (
    <IPad step={5} totalSteps={5} animKey="preview">
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
            aspectRatio: '2768/6000',
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
          {exportFailed && (
            <div data-ui="export-error" style={{
              marginBottom: 10, textAlign: 'center', color: '#FF4E50',
              fontSize: 14, fontWeight: 700,
            }}>
              {T.preview.exportError}
            </div>
          )}
          <button className="btn-primary" onClick={handleSave} disabled={!ready || saving}>
            {saving ? T.preview.saving : T.preview.save}
          </button>
        </div>
      </Page>
    </IPad>
  );
}
