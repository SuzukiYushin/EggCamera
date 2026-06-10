import { useState } from 'react';
import './styles/global.css';
import { LangProvider } from './LangContext';
import { Start }        from './components/screens/Start';
import { Nickname }     from './components/screens/Nickname';
import { Birthday }     from './components/screens/Birthday';
import { Capture }      from './components/screens/Capture';
import { PhotoSelect }  from './components/screens/PhotoSelect';
import { FinalPreview } from './components/screens/FinalPreview';
import { Uploading }    from './components/screens/Uploading';
import { QR }           from './components/screens/QR';
import { End }          from './components/screens/End';
import { FRAMES }       from './data/frames';

type Screen = 'start' | 'nick' | 'bday' | 'capture' | 'photosel' | 'preview' | 'upload' | 'qr' | 'end';

const NAV_TABS: [Screen, string][] = [
  ['start',    '① スタート'],
  ['nick',     '② ニックネーム'],
  ['bday',     '③ 生年月日'],
  ['capture',  '④ 撮影'],
  ['photosel', '⑤ 写真選択'],
  ['preview',  '⑥ プレビュー'],
  ['upload',   '⑦ 保存中'],
  ['qr',       '⑧ QR'],
  ['end',      '⑨ 終了'],
];

export default function App() {
  const [screen, setScreen]         = useState<Screen>('start');
  const [nickname, setNickname]     = useState('');
  const [days, setDays]             = useState(0);
  const [frameLabel, setFrameLabel] = useState('');

  const go = (s: Screen) => setScreen(s);

  const goCapture = (d: number) => {
    const frame = FRAMES[Math.floor(Math.random() * FRAMES.length)];
    setDays(d);
    setFrameLabel(frame.label);
    go('capture');
  };

  const restart = () => {
    setNickname('');
    setDays(0);
    setFrameLabel('');
    go('start');
  };

  return (
    <LangProvider>
      <div style={{
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        minHeight: '100vh', padding: '40px 20px', gap: 20,
      }}>
        <nav className="screen-nav">
          {NAV_TABS.map(([id, label]) => (
            <button
              key={id}
              className={`screen-nav-btn${screen === id ? ' active' : ''}`}
              onClick={() => go(id)}
            >{label}</button>
          ))}
        </nav>

        {screen === 'start'    && <Start       onNext={() => go('nick')} />}
        {screen === 'nick'     && <Nickname    nickname={nickname} onChange={setNickname} onNext={() => go('bday')} onSkip={() => go('bday')} />}
        {screen === 'bday'     && <Birthday    nickname={nickname} onNext={goCapture} onSkip={() => goCapture(0)} />}
        {screen === 'capture'  && <Capture     onNext={() => go('photosel')} />}
        {screen === 'photosel' && <PhotoSelect onNext={() => go('preview')} onBack={() => go('capture')} />}
        {screen === 'preview'  && <FinalPreview nickname={nickname} days={days} frameLabel={frameLabel} onNext={() => go('upload')} />}
        {screen === 'upload'   && <Uploading   onNext={() => go('qr')} />}
        {screen === 'qr'       && <QR          onDone={() => go('end')} onRestart={restart} />}
        {screen === 'end'      && <End         onRestart={restart} />}
      </div>
    </LangProvider>
  );
}
