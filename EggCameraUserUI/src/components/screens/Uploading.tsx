import { useState, useEffect } from 'react';
import { IPad } from '../IPad';

interface UploadingProps {
  onNext: () => void;
}

export function Uploading({ onNext }: UploadingProps) {
  const [prog, setProg] = useState(0);

  useEffect(() => {
    if (prog >= 100) {
      const t = setTimeout(onNext, 400);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setProg(p => Math.min(p + 8, 100)), 80);
    return () => clearTimeout(t);
  }, [prog, onNext]);

  const circumference = 2 * Math.PI * 42;

  return (
    <IPad step={7} animKey="upload">
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '64px 80px', gap: 36,
      }}>
        {/* Circular progress */}
        <div style={{ position: 'relative', width: 100, height: 100 }}>
          <svg width="100" height="100" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="42" fill="none"
              stroke="var(--color-gray-100)" strokeWidth="6" />
            <circle cx="50" cy="50" r="42" fill="none"
              stroke="var(--color-brand-400)" strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - prog / 100)}
              transform="rotate(-90 50 50)"
              style={{ transition: 'stroke-dashoffset 0.1s' }} />
          </svg>
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'Noto Sans JP', fontWeight: 300, fontSize: 18,
            color: 'var(--color-brand-500)',
          }}>
            {prog < 100 ? `${prog}%` : '✓'}
          </div>
        </div>

        <div style={{ textAlign: 'center' }}>
          <div className="t-heading" style={{ fontSize: 24, marginBottom: 8 }}>
            {prog < 100 ? '写真を保存しています' : '保存完了'}
          </div>
          <div className="t-body" style={{ fontSize: 14 }}>
            {prog < 100 ? 'しばらくお待ちください…' : 'QRコードを表示します'}
          </div>
        </div>

        <div
          role="progressbar"
          aria-valuenow={prog}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="写真を保存中"
          style={{ width: '100%', height: 4, background: 'var(--color-gray-100)', borderRadius: 2, overflow: 'hidden' }}
        >
          <div style={{
            height: '100%', width: `${prog}%`,
            background: 'var(--color-brand-400)',
            borderRadius: 2,
            transition: 'width 0.1s',
          }} />
        </div>

        <div className="t-caption">自動で次の画面へ進みます</div>
      </div>
    </IPad>
  );
}
