import { useState, useEffect } from 'react';
import { IPad } from '../IPad';
import { useLang } from '../../LangContext';
import { getSession } from '../../api';
import type { SessionResult } from '../../api';
import bearImg from '../../assets/bear_uploading.png';

interface UploadingProps {
  sessionId: string | null;
  onResult: (result: SessionResult) => void;
  onNext: () => void;
  onRetry: () => void;
}

export function Uploading({ sessionId, onResult, onNext, onRetry }: UploadingProps) {
  const { T } = useLang();
  const [prog, setProg] = useState(0);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const session = await getSession(sessionId);
        if (cancelled) return;

        if (session.status === 'done' && session.result) {
          setProg(100);
          onResult(session.result);
          timer = setTimeout(onNext, 400);
          return;
        }
        if (session.status === 'error') {
          setError(true);
          return;
        }
        setProg(p => Math.min(p + 6, 90));
        timer = setTimeout(poll, 1000);
      } catch {
        if (!cancelled) timer = setTimeout(poll, 1000);
      }
    };

    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sessionId, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRetry = () => {
    setError(false);
    setProg(0);
    onRetry();
    setAttempt(a => a + 1);
  };

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
              {error ? T.uploading.error : prog < 100 ? T.uploading.saving : T.uploading.done}
            </div>
            <div style={{
              fontFamily: "var(--font-ui)",
              fontSize: 12, fontWeight: 600,
              color: 'var(--color-brand-600)',
              marginBottom: 50,
              visibility: !error && prog < 100 ? 'visible' : 'hidden',
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
            background: error ? 'var(--color-gray-300)' : 'var(--color-brand-400)',
            transition: 'width 0.18s cubic-bezier(0.22, 1, 0.36, 1)',
          }} />
        </div>

        {/* Retry on error */}
        {error && (
          <div style={{ marginTop: 32, width: '80%' }}>
            <button className="btn-primary" onClick={handleRetry}>
              {T.uploading.retry}
            </button>
          </div>
        )}

      </div>
    </IPad>
  );
}
