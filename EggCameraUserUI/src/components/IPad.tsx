import type { ReactNode } from 'react';

interface IPadProps {
  step?: number;
  totalSteps?: number;
  lightStatus?: boolean;
  children: ReactNode;
  animKey?: string;
}

export function IPad({ step, totalSteps = 9, lightStatus = false, children, animKey }: IPadProps) {
  const pct = step != null ? ((step - 1) / (totalSteps - 1)) * 100 : 0;
  const statusColor = lightStatus ? '#fff' : 'var(--color-ink-500)';
  const brandColor = lightStatus ? 'rgba(255,255,255,0.9)' : 'var(--color-brand-500)';

  return (
    <div className="ipad-shell">
      <div className="status-bar" style={{ color: statusColor }}>
        <span>9:41</span>
        <span className="brand-name" style={{ color: brandColor }}>Egg Camera</span>
        <span>WiFi</span>
      </div>

      {step != null && (
        <div className="prog-bar">
          <div className="prog-fill" style={{ width: `${pct}%` }} />
        </div>
      )}

      <div
        className="screen"
        key={animKey}
        style={{ marginTop: step == null ? 32 : 0 }}
      >
        {children}
      </div>
    </div>
  );
}
