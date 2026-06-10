import { useState, useEffect } from 'react';
import { IPad } from '../IPad';
import { useLang } from '../../LangContext';
import bearImg from '../../assets/bear_uploading.png';

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
    const t = setTimeout(() => setProg(p => Math.min(p + 4, 100)), 80);
    return () => clearTimeout(t);
  }, [prog, onNext]);

  return (
    <IPad animKey="upload" statusBg="var(--color-brand-500)">
      <div data-section="uploading-screen" style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '40px 56px 56px',
      }}>

        {/* Bear + text row */}
        <div style={{
          position: 'relative',
          display: 'flex', alignItems: 'center', gap: 28,
          width: '100%', marginBottom: 0,
        }}>
          <img
            src={bearImg}
            alt=""
            aria-hidden="true"
            style={{
              position: 'absolute', left: 60, top: '0%', transform: 'translateY(-50%)',
              width: 190, height: 'auto', flexShrink: 0, display: 'block',
            }}
          />
          <div style={{ width: '100%', textAlign: 'center' }}>
            <div style={{
              fontFamily: "var(--font-heading)",
              fontSize: 20, fontWeight: 600,
              color: 'var(--color-brand-600)',
              marginBottom: 10,
              lineHeight: 1.3,
            }}>
              {prog < 100 ? T.uploading.saving : T.uploading.done}
            </div>
            <div style={{
              fontFamily: "var(--font-ui)",
              fontSize: 12, fontWeight: 600,
              color: 'var(--color-brand-600)',
              marginBottom: 50,
              visibility: prog < 100 ? 'visible' : 'hidden',
            }}>
              {T.uploading.wait}
            </div>
          </div>
        </div>

        {/* Progress bar */}
        <div
          role="progressbar"
          aria-valuenow={prog}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={T.uploading.saving}
          style={{
            width: '80%', height: 13,
            background: 'rgba(81,143,204,0.15)',
            borderRadius: 99, overflow: 'hidden',
          }}
        >
          <div style={{
            height: '100%', width: `${prog}%`,
            borderRadius: 99,
            background: 'var(--color-brand-400)',
            transition: 'width 0.18s cubic-bezier(0.22, 1, 0.36, 1)',
          }} />
        </div>

      </div>
    </IPad>
  );
}
