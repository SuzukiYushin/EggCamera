import { type ReactNode } from 'react';
import { PROTO } from '../api';
import { useFitScale } from './viewport';

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
