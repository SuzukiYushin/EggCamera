import { useState, useEffect } from 'react';
import { IPad } from '../IPad';
import { useLang } from '../../LangContext';
import { getSession } from '../../api';
import type { SessionResult } from '../../api';
import { reportClientError } from '../../clientLog';
import bearImg from '../../assets/bear_uploading.png';

interface UploadingProps {
  sessionId: string | null;
  onResult: (result: SessionResult) => void;
  onNext: () => void;
  onError: () => void;
}

// ポーリングの上限。超えたら全画面のお詫びオーバーレイへ
const MAX_POLL_FAILURES = 20;   // 連続失敗 約20秒
const OVERALL_TIMEOUT_MS = 90_000;

export function Uploading({ sessionId, onResult, onNext, onError }: UploadingProps) {
  const { T } = useLang();
  const [prog, setProg] = useState(0);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const startedAt = Date.now();

    const poll = async () => {
      if (Date.now() - startedAt > OVERALL_TIMEOUT_MS) {
        reportClientError('upload timed out (90s)');
        onError();
        return;
      }
      try {
        const session = await getSession(sessionId);
        if (cancelled) return;
        failures = 0;

        if (session.status === 'done' && session.result) {
          setProg(100);
          onResult(session.result);
          timer = setTimeout(onNext, 400);
          return;
        }
        if (session.status === 'error') {
          reportClientError(`upload failed: ${session.error}`);
          onError();
          return;
        }
        setProg(p => Math.min(p + 6, 90));
        timer = setTimeout(poll, 1000);
      } catch {
        if (cancelled) return;
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) {
          reportClientError(`session polling failed ${MAX_POLL_FAILURES} times in a row`);
          onError();
          return;
        }
        timer = setTimeout(poll, 1000);
      }
    };

    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <IPad animKey="upload">
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
