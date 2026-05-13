import { useState } from 'react';
import './styles/global.css';
import { Start } from './components/screens/Start';
import { Nickname } from './components/screens/Nickname';
import { Birthday } from './components/screens/Birthday';
import { FrameSelection } from './components/screens/FrameSelection';
import { Capture } from './components/screens/Capture';
import { PhotoSelect } from './components/screens/PhotoSelect';
import { FinalPreview } from './components/screens/FinalPreview';
import { Uploading } from './components/screens/Uploading';
import { QR } from './components/screens/QR';
import { End } from './components/screens/End';

type Screen =
  | 'start' | 'nick' | 'bday' | 'frame'
  | 'capture' | 'photosel' | 'preview'
  | 'upload' | 'qr' | 'end';

const NAV_TABS: [Screen, string][] = [
  ['start',    '① スタート'],
  ['nick',     '② ニックネーム'],
  ['bday',     '③ 生年月日'],
  ['frame',    '④ フレーム選択'],
  ['capture',  '⑤ 撮影中'],
  ['photosel', '⑥ 写真選択'],
  ['preview',  '⑦ プレビュー'],
  ['upload',   '⑧ 保存中'],
  ['qr',       '⑨ QR'],
  ['end',      '⑩ 終了'],
];

export default function App() {
  const [screen, setScreen] = useState<Screen>('start');
  const go = (s: Screen) => setScreen(s);

  return (
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
          >
            {label}
          </button>
        ))}
      </nav>

      {screen === 'start'    && <Start       onNext={() => go('nick')} />}
      {screen === 'nick'     && <Nickname    onNext={() => go('bday')} onSkip={() => go('bday')} />}
      {screen === 'bday'     && <Birthday    onNext={() => go('frame')} onSkip={() => go('frame')} />}
      {screen === 'frame'    && <FrameSelection onNext={() => go('capture')} />}
      {screen === 'capture'  && <Capture     onNext={() => go('photosel')} />}
      {screen === 'photosel' && <PhotoSelect onNext={() => go('preview')} />}
      {screen === 'preview'  && <FinalPreview onNext={() => go('upload')} onBack={() => go('frame')} />}
      {screen === 'upload'   && <Uploading   onNext={() => go('qr')} />}
      {screen === 'qr'       && <QR          onNext={() => go('end')} onRestart={() => go('start')} />}
      {screen === 'end'      && <End         onRestart={() => go('start')} />}
    </div>
  );
}
