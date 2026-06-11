import { useState, useEffect } from 'react';
import { IPad } from '../IPad';
import { useLang } from '../../LangContext';
import type { SessionResult } from '../../api';

interface QRProps {
  result: SessionResult | null;
  onDone: () => void;
  onRestart: () => void;
}

export function QR({ result, onDone, onRestart }: QRProps) {
  const { T } = useLang();
  const [secs, setSecs] = useState(() =>
    result ? Math.max(0, Math.ceil((result.expiresAt - Date.now()) / 1000)) : 0
  );

  useEffect(() => {
    if (!result) return;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((result.expiresAt - Date.now()) / 1000));
      setSecs(remaining);
      if (remaining <= 0) onDone();
    };
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [result, onDone]);

  const mm     = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss     = String(secs % 60).padStart(2, '0');
  const urgent = secs < 60;

  return (
    <IPad animKey="qr">
      <div data-section="qr-screen" style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        padding: '50px 60px 44px',
      }}>

        {/* Step label */}
        <div className="t-eyebrow" style={{ marginBottom: 150 }}>{T.qr.step}</div>

        {/* Headings — centered, 2 lines */}
        <div style={{ textAlign: 'center', marginBottom: 30 }}>
          <div style={{
            fontFamily: "var(--font-ui)",
            fontSize: 20, fontWeight: 700,
            color: 'var(--color-brand-600)',
            lineHeight: 1.5,
            letterSpacing: '0.1em',
          }}>
            {T.qr.heading}<br />{T.qr.subheading}
          </div>
        </div>

        {/* Body text */}
        <div style={{
          fontFamily: "var(--font-ui)", fontSize: 14, fontWeight: 600,
          color: 'var(--color-brand-600)',
          textAlign: 'center', marginBottom: 70,
          lineHeight: 1.7,
        }}>{T.qr.body}</div>

        {/* QR code — centered, no frame */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 28 }}>
          {result && (
            <img
              src={result.qrDataUrl}
              alt="QR code"
              width={200} height={200}
              style={{ display: 'block' }}
            />
          )}
        </div>

        {/* Timer pill — compact */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'auto' }}>
          <div data-ui="qr-timer" style={{
            background: urgent ? '#DC2626' : 'var(--color-brand-500)',
            color: '#fff',
            borderRadius: 99,
            width: 227, height: 86,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background 0.3s',
          }}>
            <div style={{
              fontFamily: "var(--font-ui)", fontSize: 17, fontWeight: 400,
              letterSpacing: '0.1em',
              textAlign: 'center',
              lineHeight: '28px',
              whiteSpace: 'pre-line',
            }}>{`${T.qr.timer}\n${mm}:${ss}`}</div>
          </div>
        </div>

        {/* Restart */}
        <div style={{ flexShrink: 0 }}>
          <button className="btn-ghost" onClick={onRestart}>{T.qr.restart}</button>
        </div>

      </div>
    </IPad>
  );
}
