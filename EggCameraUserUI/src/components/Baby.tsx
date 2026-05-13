interface BabyProps {
  size?: number;
  color?: string;
  faceColor?: string;
}

export function Baby({ size = 160, color = '#B8D2E8', faceColor = '#7AAAD4' }: BabyProps) {
  const s = size / 180;
  return (
    <svg width={180 * s} height={180 * s} viewBox="0 0 180 180" fill="none">
      <circle cx="90" cy="46" r="34" fill={color} />
      <ellipse cx="90" cy="112" rx="44" ry="52" fill={color} />
      <ellipse cx="42" cy="112" rx="14" ry="26" fill={color} transform="rotate(-14 42 112)" />
      <ellipse cx="138" cy="112" rx="14" ry="26" fill={color} transform="rotate(14 138 112)" />
      <ellipse cx="74" cy="165" rx="10" ry="14" fill={color} />
      <ellipse cx="106" cy="165" rx="10" ry="14" fill={color} />
      <circle cx="81" cy="43" r="3.5" fill={faceColor} />
      <circle cx="99" cy="43" r="3.5" fill={faceColor} />
      <path d="M83 56 Q90 63 97 56" stroke={faceColor} strokeWidth="2.2" strokeLinecap="round" fill="none" />
    </svg>
  );
}
