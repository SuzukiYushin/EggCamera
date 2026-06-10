import type { ReactNode } from 'react';

interface IPadProps {
  step?: number;
  totalSteps?: number;
  lightStatus?: boolean;
  statusBg?: string;
  statusTextColor?: string;
  children: ReactNode;
  animKey?: string;
}

export function IPad({ step, totalSteps = 7, lightStatus = false, statusBg, statusTextColor, children, animKey }: IPadProps) {
  const pct = step != null ? ((step - 1) / (totalSteps - 1)) * 100 : 0;
  const hasColoredBar = lightStatus || !!statusBg;
  const autoTextColor = hasColoredBar ? '#fff' : 'var(--color-ink-500)';
  const effectiveTextColor = statusTextColor ?? autoTextColor;
  const brandColor = statusTextColor ?? (hasColoredBar ? 'rgba(255,255,255,0.9)' : 'var(--color-brand-500)');

  return (
    <div className="ipad-shell">
      {/* Status bar — optionally with a solid background color */}
      <div
        className="status-bar"
        style={{
          color: effectiveTextColor,
          background: statusBg ?? 'transparent',
        }}
      >
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
