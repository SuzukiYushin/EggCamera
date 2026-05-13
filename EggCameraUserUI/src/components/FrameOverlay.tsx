type FrameType = 'flower' | 'simple' | 'stars' | 'rainbow';

interface FrameOverlayProps {
  type: FrameType;
  size?: number;
}

export function FrameOverlay({ type, size = 400 }: FrameOverlayProps) {
  const style: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
  };

  if (type === 'flower') return (
    <svg width={size} height={size} viewBox="0 0 400 400" style={style}>
      {([[28, 28], [372, 28], [28, 372], [372, 372]] as [number, number][]).map(([cx, cy], i) => (
        <g key={i} transform={`translate(${cx},${cy})`}>
          {[0, 60, 120, 180, 240, 300].map(a => (
            <ellipse key={a} cx="0" cy="-11" rx="5" ry="9"
              fill="rgba(184,210,232,0.7)"
              transform={`rotate(${a})`} />
          ))}
          <circle cx="0" cy="0" r="5" fill="rgba(122,170,212,0.8)" />
        </g>
      ))}
      <rect x="12" y="12" width="376" height="376" rx="8"
        fill="none" stroke="rgba(184,210,232,0.5)" strokeWidth="1.5" />
    </svg>
  );

  if (type === 'stars') return (
    <svg width={size} height={size} viewBox="0 0 400 400" style={style}>
      {([[30, 30], [370, 30], [30, 370], [370, 370], [200, 20], [20, 200], [380, 200], [200, 380]] as [number, number][]).map(([cx, cy], i) => (
        <text key={i} x={cx} y={cy} textAnchor="middle" dominantBaseline="middle"
          fontSize="18" fill="rgba(122,170,212,0.6)">✦</text>
      ))}
      <rect x="10" y="10" width="380" height="380" rx="8"
        fill="none" stroke="rgba(184,210,232,0.4)" strokeWidth="1.5" strokeDasharray="4 4" />
    </svg>
  );

  if (type === 'simple') return (
    <svg width={size} height={size} viewBox="0 0 400 400" style={style}>
      <rect x="16" y="16" width="368" height="368" rx="10"
        fill="none" stroke="rgba(184,210,232,0.8)" strokeWidth="2" />
      <rect x="26" y="26" width="348" height="348" rx="6"
        fill="none" stroke="rgba(184,210,232,0.4)" strokeWidth="1" />
    </svg>
  );

  if (type === 'rainbow') return (
    <svg width={size} height={size} viewBox="0 0 400 400" style={style}>
      {(['#B8D2E8', '#C8E0C0', '#F0D0B0', '#E0C0D8'] as string[]).map((c, i) => (
        <rect key={i}
          x={10 + i * 6} y={10 + i * 6}
          width={380 - i * 12} height={380 - i * 12}
          rx={12 + i * 2}
          fill="none" stroke={c} strokeWidth="2" opacity="0.7" />
      ))}
    </svg>
  );

  return null;
}
