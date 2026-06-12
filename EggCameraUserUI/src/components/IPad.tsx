import { useEffect, useState, type ReactNode } from 'react';
import { PROTO } from '../api';

const DESIGN_WIDTH = 768;
const DESIGN_HEIGHT = 1024;

// プロトタイプでは上部の画面選択ナビのぶんだけキャンバスを小さくする
const NAV_OFFSET = PROTO ? 64 : 0;

// Scales the fixed-size (768×1024) design canvas to fit the real device
// viewport, preserving aspect ratio (letterboxed via .app-viewport).
export function useFitScale() {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const update = () => {
      setScale(Math.min(window.innerWidth / DESIGN_WIDTH, (window.innerHeight - NAV_OFFSET) / DESIGN_HEIGHT));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return scale;
}

interface IPadProps {
  step?: number;
  totalSteps?: number;
  children: ReactNode;
  animKey?: string;
}

export function IPad({ step, totalSteps = 7, children, animKey }: IPadProps) {
  const scale = useFitScale();
  const pct = step != null ? ((step - 1) / (totalSteps - 1)) * 100 : 0;

  return (
    <div className={`app-viewport${PROTO ? ' proto-viewport' : ''}`}>
      <div className="ipad-shell" style={{ transform: `scale(${scale})` }}>
        {step != null && (
          <div className="prog-bar">
            <div className="prog-fill" style={{ width: `${pct}%` }} />
          </div>
        )}

        <div className="screen" key={animKey}>
          {children}
        </div>
      </div>
    </div>
  );
}
