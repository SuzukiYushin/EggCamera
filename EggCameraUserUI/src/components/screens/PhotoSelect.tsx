import { useState, useEffect } from 'react';
import { IPad } from '../IPad';
import { useLang } from '../../LangContext';
import { PROTO } from '../../api';
import type { SessionPhoto } from '../../api';
import { FINAL_ASPECT, PHOTO_ASPECT, computePlacement, type PreviewPlacement } from '../../cropPlacement';

interface PhotoSelectProps {
  photos: SessionPhoto[];
  onNext: (photoId: string) => void;
  onBack: () => void;
}

// サムネイルは「完成画像の切り取り後」と同じ画角・同じ切り出し位置で並べる。
// cover 中央トリミングのままだと管理画面の横シフト(offsetX)が効かず、
// ライブビューで見えていた範囲と仕上がりがズレる（基準はライブビュー側が正しい）。

export function PhotoSelect({ photos, onNext, onBack }: PhotoSelectProps) {
  const { T } = useLang();
  const [sel, setSel] = useState<string | null>(photos[1]?.photoId ?? photos[0]?.photoId ?? null);
  // 撮影画面のライブビューと同じ切り出し（管理画面の trim / 横シフト / 縦シフトを反映）。
  // ★元画像はライブ映像(3:4縦)ではなく撮影写真(4:3横)。取り違えると縦に伸びる。
  const [srcAspect, setSrcAspect] = useState(PHOTO_ASPECT);
  const [crop, setCrop] = useState({ trim: 0, offsetX: 0, offsetY: 0 });
  const placement: PreviewPlacement = computePlacement(crop.trim, crop.offsetX, crop.offsetY, srcAspect);

  useEffect(() => {
    if (PROTO) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/settings', { cache: 'no-store' });
        const s = await res.json();
        if (cancelled) return;
        setCrop({
          trim: Number(s?.crop?.trim) || 0,
          offsetX: Number(s?.crop?.offsetX) || 0,
          offsetY: Number(s?.crop?.offsetY) || 0,
        });
      } catch { /* 取得失敗時は既定(切り出しなし)のまま */ }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <IPad step={4} totalSteps={5} animKey="photosel">
      <div data-section="photoselect-screen" style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        padding: '50px 40px 0',
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
          {photos.map((photo, i) => (
            <div
              key={photo.photoId}
              role="radio"
              aria-checked={sel === photo.photoId}
              aria-label={`写真 ${i + 1}`}
              tabIndex={0}
              onClick={() => setSel(photo.photoId)}
              onKeyDown={e => (e.key === ' ' || e.key === 'Enter') && setSel(photo.photoId)}
              style={{
                flex: 1,
                aspectRatio: String(FINAL_ASPECT),
                maxHeight: '100%',
                borderRadius: 8,
                overflow: 'hidden',
                cursor: 'pointer',
                position: 'relative',
                // 選択枠は border ではなく box-shadow の実線リングで描く。
                // border だと aspect-ratio は枠込み・img の % は枠の内側基準になり、
                // その差のぶん画像が縦に伸びる（2026-08-05 実測 1.285 vs 正 1.333）。
                // box-shadow は要素のボックスサイズに影響しないので比率が狂わない。
                boxShadow: sel === photo.photoId
                  ? '0 0 0 9.5px var(--color-brand-500)'
                  : '0 2px 12px rgba(0,0,0,0.12)',
                transition: 'box-shadow 0.15s',
              }}
            >
              {/* cover ではなく絶対配置。ライブビューと同じ矩形を切り出して見せる。
                  実際の縦横比は naturalWidth/Height で確定させる（写真サイズが変わっても伸びない） */}
              <img
                src={photo.url}
                alt=""
                aria-hidden="true"
                onLoad={e => {
                  const el = e.currentTarget;
                  if (el.naturalWidth && el.naturalHeight) {
                    const a = el.naturalWidth / el.naturalHeight;
                    setSrcAspect(prev => (Math.abs(prev - a) > 0.001 ? a : prev));
                  }
                }}
                style={{ position: 'absolute', display: 'block', ...placement }}
              />
            </div>
          ))}
        </div>

        {/* Decide button */}
        <div className="screen-actions" style={{ marginTop: 32 }}>
          <button
            className="btn-primary"
            disabled={sel === null}
            onClick={() => sel !== null && onNext(sel)}
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
