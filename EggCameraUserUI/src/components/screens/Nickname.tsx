import { useState } from 'react';
import { IPad } from '../IPad';
import { Page } from '../Page';
import { useLang } from '../../LangContext';

interface NicknameProps {
  nickname: string;
  onChange: (v: string) => void;
  onNext: () => void;
  onSkip: () => void;
}

const KB_ROWS = [
  ['q','w','e','r','t','y','u','i','o','p'],
  ['a','s','d','f','g','h','j','k','l'],
  ['z','x','c','v','b','n','m'],
];

export function Nickname({ nickname, onChange, onNext, onSkip }: NicknameProps) {
  const { T } = useLang();
  const [focused, setFocused] = useState(false);

  return (
    <IPad step={1} totalSteps={7} animKey="nick">
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
            onChange={e => onChange(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={T.nickname.placeholder}
          />
        </div>
        <div className="t-body" style={{ marginBottom: 'auto' }}>{T.nickname.body}</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 32, marginTop: 24 }}>
          <button className="btn-primary" onClick={onNext}>{T.nickname.next}</button>
          <button className="btn-ghost" onClick={onSkip}>{T.nickname.skip}</button>
        </div>
      </Page>

      <div className="keyboard-ph">
        {KB_ROWS.map((row, ri) => (
          <div className="kb-row" key={ri}>
            {ri === 2 && <div className="kb-key dark wide">⇧</div>}
            {row.map(k => <div className="kb-key" key={k}>{k}</div>)}
            {ri === 2 && <div className="kb-key dark wide">⌫</div>}
          </div>
        ))}
        <div className="kb-row">
          <div className="kb-key dark wide">123</div>
          <div className="kb-key space">スペース</div>
          <div className="kb-key dark wide confirm">確定</div>
        </div>
      </div>
    </IPad>
  );
}
