import type { CSSProperties, ReactNode } from 'react';

interface PageProps {
  children: ReactNode;
  style?: CSSProperties;
  // data-section など任意のdata属性を透過させる（画面判定や自動テストが参照する）
  [key: `data-${string}`]: string | undefined;
}

export function Page({ children, style, ...rest }: PageProps) {
  return (
    <div
      {...rest}
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        padding: '0 48px',
        overflow: 'hidden',
        ...style,
      }}
    >
      {children}
    </div>
  );
}
