import { useState, useEffect } from 'react';
import { IPad } from '../IPad';
import { Page } from '../Page';

interface QRProps {
  onNext: () => void;
  onRestart: () => void;
}

const QR_CELLS = [
  [1,1,1,1,1,1,1,0,1,0,1,0,1,1,1,1,1],
  [1,0,0,0,0,0,1,0,0,1,0,1,1,0,0,0,1],
  [1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,1,1],
  [1,0,1,1,1,0,1,0,0,1,0,1,1,0,1,1,1],
  [1,0,0,0,0,0,1,0,1,0,1,0,1,0,0,0,1],
  [1,1,1,1,1,1,1,0,1,0,1,1,1,1,1,1,1],
  [0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0],
  [1,0,1,1,0,1,1,1,1,0,1,0,1,0,1,0,1],
  [0,1,0,0,1,0,0,0,0,1,0,1,0,1,0,1,0],
  [1,0,1,0,1,1,1,0,1,0,1,0,1,0,1,1,1],
  [0,0,0,0,0,0,0,0,0,1,0,0,0,1,0,0,0],
  [1,1,1,1,1,1,1,0,1,0,1,0,1,1,1,0,1],
  [1,0,0,0,0,0,1,0,0,1,0,1,0,0,0,1,0],
  [1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,1],
  [1,0,0,0,0,0,1,0,0,1,0,0,0,1,0,0,1],
  [1,1,1,1,1,1,1,0,1,0,1,1,0,0,1,0,1],
];

const STEPS = [
  { n: '1', t: 'スマホのカメラを開く' },
  { n: '2', t: 'QRコードをかざす' },
  { n: '3', t: '写真をダウンロード' },
];

export function QR({ onRestart }: QRProps) {
  const [secs, setSecs] = useState(600);

  useEffect(() => {
    const t = setInterval(() => setSecs(s => Math.max(s - 1, 0)), 1000);
    return () => clearInterval(t);
  }, []);

  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  const urgent = secs < 60;

  return (
    <IPad step={8} animKey="qr">
      <Page style={{ paddingTop: 28, paddingBottom: 36 }}>
        <div className="t-eyebrow" style={{ marginBottom: 10 }}>ステップ 8 / 9</div>
        <div className="t-heading" style={{ fontSize: 26, marginBottom: 4 }}>
          写真の準備ができました
        </div>
        <div className="t-body" style={{ fontSize: 14, marginBottom: 24 }}>
          QRコードをスキャンして受け取ってください
        </div>

        <div style={{ flex: 1, display: 'flex', gap: 40, alignItems: 'center' }}>
          {/* QR code */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <div className="qr-frame">
              <svg
                width={200} height={200}
                viewBox={`0 0 ${QR_CELLS.length} ${QR_CELLS.length}`}
                shapeRendering="crispEdges"
              >
                <rect width={QR_CELLS.length} height={QR_CELLS.length} fill="white" />
                {QR_CELLS.flatMap((row, y) =>
                  row.map((v, x) =>
                    v ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="#2A2A2A" /> : null
                  )
                )}
              </svg>
            </div>
            <div className="t-caption" style={{ textAlign: 'center' }}>
              スマホのカメラでスキャン
            </div>
          </div>

          {/* Instructions + timer */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 20 }}>
            {STEPS.map(s => (
              <div key={s.n} style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                <div style={{
                  width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                  background: 'var(--color-brand-500)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#fff', fontFamily: 'Noto Sans JP', fontWeight: 500, fontSize: 15,
                }}>{s.n}</div>
                <div style={{
                  fontFamily: 'Noto Sans JP', fontSize: 17,
                  color: 'var(--color-ink-900)',
                }}>{s.t}</div>
              </div>
            ))}

            <div style={{
              padding: '14px 20px', borderRadius: 4,
              background: urgent ? '#FEF2F2' : 'var(--color-brand-50)',
              border: `1px solid ${urgent ? '#FECACA' : 'var(--color-brand-100)'}`,
              transition: 'background 0.3s',
            }}>
              <div className="t-caption" style={{ marginBottom: 4 }}>有効期限まで</div>
              <div style={{
                fontFamily: 'Noto Sans JP', fontWeight: 300, fontSize: 36,
                color: urgent ? '#DC2626' : 'var(--color-brand-500)',
                transition: 'color 0.3s',
              }}>{mm}:{ss}</div>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
          <button className="btn-ghost" style={{ flex: 1 }} onClick={onRestart}>
            TOPに戻る
          </button>
        </div>
      </Page>
    </IPad>
  );
}
