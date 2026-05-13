import { IPad } from '../IPad';
import { Page } from '../Page';
import flameImg from '../../assets/flame.png';
import babyImg  from '../../assets/baby.png';

interface FinalPreviewProps {
  nickname:   string;
  days:       number;
  frameLabel: string;
  onNext: () => void;
}

export function FinalPreview({ nickname, days, frameLabel, onNext }: FinalPreviewProps) {
  const badge = [nickname, days > 0 ? `生後 ${days}日` : ''].filter(Boolean).join(' — ');

  return (
    <IPad step={4} totalSteps={7} animKey="preview">
      <Page style={{ paddingTop: 28, paddingBottom: 32 }}>
        <div className="t-eyebrow" style={{ marginBottom: 10 }}>ステップ 4 / 7</div>
        <div className="t-heading" style={{ fontSize: 24, marginBottom: 4 }}>完成イメージ</div>
        <div className="t-body" style={{ fontSize: 13, marginBottom: 16 }}>
          フレームと写真の合成プレビュー
        </div>

        <div style={{
          flex: 1,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          minHeight: 0,
        }}>
          <div style={{
            position: 'relative',
            aspectRatio: '2/3',
            height: '100%',
            maxHeight: 680,
            borderRadius: 4,
            overflow: 'hidden',
            border: '1.5px solid var(--color-brand-100)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.1)',
          }}>
            <img src={babyImg} alt="赤ちゃんの写真"
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            <img src={flameImg} alt="フレーム"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill', display: 'block', pointerEvents: 'none' }} />

            {badge && (
              <div style={{
                position: 'absolute', top: 14, left: 0, right: 0,
                display: 'flex', justifyContent: 'center', pointerEvents: 'none',
              }}>
                <div style={{
                  background: 'rgba(255,255,255,0.9)', borderRadius: 4, padding: '6px 20px',
                  border: '1px solid rgba(163,196,230,0.6)', backdropFilter: 'blur(6px)',
                  fontFamily: 'Noto Sans JP', fontSize: 12,
                  color: 'var(--color-brand-700)', fontWeight: 500,
                }}>{badge}</div>
              </div>
            )}

            <div style={{
              position: 'absolute', bottom: 10, right: 14,
              fontFamily: 'Cormorant Garamond, serif', fontStyle: 'italic',
              fontSize: 11, color: 'rgba(81,143,204,0.6)', letterSpacing: '0.1em',
              pointerEvents: 'none',
            }}>Egg Camera</div>
          </div>
        </div>

        {frameLabel && (
          <div style={{
            fontFamily: 'Noto Sans JP', fontSize: 12,
            color: 'var(--color-ink-300)', textAlign: 'center', marginTop: 10,
          }}>
            フレーム：{frameLabel}
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <button className="btn-primary" onClick={onNext}>この写真を保存する</button>
        </div>
      </Page>
    </IPad>
  );
}
