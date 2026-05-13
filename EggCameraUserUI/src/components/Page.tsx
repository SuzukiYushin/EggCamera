import type { CSSProperties, ReactNode } from 'react';

interface PageProps {
  children: ReactNode;
  style?: CSSProperties;
}

export function Page({ children, style }: PageProps) {
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      padding: '0 48px',
      overflow: 'hidden',
      ...style,
    }}>
      {children}
    </div>
  );
}
