import { useEffect, useState } from 'react';
import { IPad } from '../IPad';
import { useFitScale, useViewportSize } from '../viewport';
import { Page } from '../Page';
import { useLang } from '../../LangContext';

interface NicknameProps {
  nickname: string;
  onChange: (v: string) => void;
  onNext: () => void;
  onSkip: () => void;
}

// Tracks the on-screen keyboard's height (via visualViewport) and converts it
// from real device pixels to the 768×1024 design canvas's pixel space.
function useKeyboardLift() {
  const scale = useFitScale();
  // 基準の画面高は実測値を使う（standalone の window.innerHeight は当てにならない）
  const { h: viewportHeight } = useViewportSize();
  const [kbHeight, setKbHeight] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      setKbHeight(Math.max(0, viewportHeight - vv.height - vv.offsetTop));
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [viewportHeight]);

  return scale > 0 ? kbHeight / scale : 0;
}

export function Nickname({ nickname, onChange, onNext, onSkip }: NicknameProps) {
  const { T } = useLang();
  const [focused, setFocused] = useState(false);
  const kbLift = useKeyboardLift();

  return (
    <IPad step={1} totalSteps={5} animKey="nick">
      <Page data-section="nickname-screen" style={{ paddingTop: 50 }}>
        <div className="t-eyebrow" style={{ marginBottom: 50, marginLeft: 0 }}>{T.nickname.step}</div>
        <div id="nickname-title" className="t-heading" style={{ marginBottom: 30, whiteSpace: 'pre-line' }}>
          {T.nickname.heading}
        </div>

        <div
          data-ui="nickname-input"
          className={`input-wrap${focused || nickname ? ' focused' : ''}`}
          style={{ marginBottom: 40 }}
        >
          <input
            id="nickname-input"
            aria-labelledby="nickname-title"
            aria-required="false"
            maxLength={10}
            value={nickname}
            onChange={e => onChange(e.target.value.replace(/[^A-Za-z]/g, ''))}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={T.nickname.placeholder}
            // アルファベットのみ。iPad で英字QWERTY キーボードを強制。
            // type="text" + pattern="[A-Za-z]*" で日本語IMEを排除し英字キーボードのみ出す。
            type="text"
            name="nickname"
            inputMode="text"
            lang="en"
            pattern="[A-Za-z]*"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="t-body" style={{ marginBottom: 'auto' }}>{T.nickname.body}</div>

        <div className="screen-actions" style={{
          marginTop: 24,
          transform: `translateY(-${kbLift}px)`,
          transition: 'transform 0.25s ease',
        }}>
          <button className="btn-primary" onClick={onNext}>{T.nickname.next}</button>
          <button className="btn-ghost" onClick={onSkip}>{T.nickname.skip}</button>
        </div>
      </Page>
    </IPad>
  );
}
