import { useState, useEffect } from 'react';
import { IPad } from '../IPad';
import { useLang } from '../../LangContext';

interface UploadingProps {
  onNext: () => void;
}

export function Uploading({ onNext }: UploadingProps) {
  const { T } = useLang();
  const [prog, setProg] = useState(0);

  useEffect(() => {
    if (prog >= 100) {
      const t = setTimeout(onNext, 400);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setProg(p => Math.min(p + 8, 100)), 80);
    return () => clearTimeout(t);
  }, [prog, onNext]);

  return (
    <IPad step={5} totalSteps={7} animKey="upload">
      <div data-section="uploading-screen" style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '64px 80px', gap: 36,
      }}>
        <div className="t-heading" style={{ fontSize: 24, textAlign: 'center' }}>
          {prog < 100 ? T.uploading.saving : T.uploading.done}
        </div>
        <div className="t-body" style={{ fontSize: 14, textAlign: 'center' }}>
          {prog < 100 ? T.uploading.wait : T.uploading.nextMsg}
        </div>

        <div
          role="progressbar"
          aria-valuenow={prog}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={T.uploading.saving}
          style={{
            width: '100%', height: 6,
            background: 'var(--color-gray-100)',
            borderRadius: 99, overflow: 'hidden',
          }}
        >
          <div style={{
            height: '100%', width: `${prog}%`,
            background: 'var(--color-brand-400)',
            borderRadius: 99, transition: 'width 0.1s',
          }} />
        </div>

        <div className="t-caption">{T.uploading.auto}</div>
      </div>
    </IPad>
  );
}
