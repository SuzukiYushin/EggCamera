import { useState, useEffect } from 'react';
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
import { ErrorOverlay } from './components/ErrorOverlay';
import { createSession, selectPhoto, uploadComposite, PROTO } from './api';
import type { SessionPhoto, SessionResult } from './api';
import { reportClientError } from './clientLog';

type Screen = 'start' | 'nick' | 'bday' | 'capture' | 'photosel' | 'preview' | 'upload' | 'qr' | 'end' | 'dl';

// クライアント確認用プロトタイプの画面選択ナビ
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
  ['dl',       '⑩ ダウンロード'],
];

// プロト専用: スマホで開くダウンロードページを iPhone 縦サイズの枠で表示
function ProtoDownload() {
  return (
    <div className="app-viewport proto-viewport">
      <div className="iphone-shell">
        <iframe src="/proto-download.html" title="ダウンロードページ" />
      </div>
    </div>
  );
}

export default function App() {
  const [screen, setScreen]         = useState<Screen>('start');
  const [sessionId, setSessionId]   = useState<string | null>(null);
  const [nickname, setNickname]     = useState('');
  const [days, setDays]             = useState(0);
  const [photos, setPhotos]         = useState<SessionPhoto[]>([]);
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null);
  const [result, setResult]         = useState<SessionResult | null>(null);
  const [fatal, setFatal]           = useState(false);

  // 想定外のエラーは全画面共通のお詫びオーバーレイ → 自動リロードでトップへ。
  // 原因はサーバログへ送って data/logs/ と管理画面で追えるようにする。
  useEffect(() => {
    const onError = (e: Event) => {
      const detail = e instanceof ErrorEvent
        ? `${e.message} @${e.filename}:${e.lineno}`
        : e instanceof PromiseRejectionEvent
          ? `unhandledrejection: ${e.reason}`
          : 'unknown error';
      reportClientError(detail);
      setFatal(true);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onError);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onError);
    };
  }, []);

  useEffect(() => {
    createSession()
      .then(({ sessionId }) => setSessionId(sessionId))
      .catch(err => { reportClientError(`createSession failed: ${err}`); setFatal(true); });
  }, []);

  const go = (s: Screen) => setScreen(s);

  const goCapture = (d: number) => {
    // フレームは FinalPreview が /api/frames から都度ランダム選択する
    setDays(d);
    go('capture');
  };

  const retake = () => {
    setPhotos([]);
    setSelectedPhotoId(null);
    createSession()
      .then(({ sessionId }) => setSessionId(sessionId))
      .catch(err => { reportClientError(`createSession failed: ${err}`); setFatal(true); });
    go('capture');
  };

  const goUpload = (blob: Blob) => {
    if (sessionId && selectedPhotoId) {
      // メタデータ記録のみ。失敗しても合成画像のアップロードには影響しない
      selectPhoto(sessionId, { photoId: selectedPhotoId, nickname, days })
        .catch(err => console.error('selectPhoto failed', err));
    }
    if (sessionId) {
      uploadComposite(sessionId, blob)
        .catch(err => { reportClientError(`uploadComposite failed: ${err}`); setFatal(true); });
    }
    go('upload');
  };

  const restart = () => {
    setNickname('');
    setDays(0);
    setPhotos([]);
    setSelectedPhotoId(null);
    setResult(null);
    createSession()
      .then(({ sessionId }) => setSessionId(sessionId))
      .catch(err => { reportClientError(`createSession failed: ${err}`); setFatal(true); });
    go('start');
  };

  const selectedPhoto = photos.find(p => p.photoId === selectedPhotoId);

  return (
    <LangProvider>
      {PROTO && (
        <nav className="screen-nav">
          {NAV_TABS.map(([id, label]) => (
            <button
              key={id}
              className={`screen-nav-btn${screen === id ? ' active' : ''}`}
              onClick={() => go(id)}
            >{label}</button>
          ))}
        </nav>
      )}
      {screen === 'start'    && <Start       onNext={() => go('nick')} />}
      {screen === 'nick'     && <Nickname    nickname={nickname} onChange={setNickname} onNext={() => go('bday')} onSkip={() => go('bday')} />}
      {screen === 'bday'     && <Birthday    nickname={nickname} onNext={goCapture} onSkip={() => goCapture(0)} />}
      {screen === 'capture'  && <Capture     sessionId={sessionId} onComplete={photos => { setPhotos(photos); go('photosel'); }} onError={() => setFatal(true)} />}
      {screen === 'photosel' && <PhotoSelect photos={photos} onNext={photoId => { setSelectedPhotoId(photoId); go('preview'); }} onBack={retake} />}
      {screen === 'preview'  && <FinalPreview nickname={nickname} days={days} photoUrl={selectedPhoto?.url ?? ''} onNext={goUpload} />}
      {screen === 'upload'   && <Uploading   sessionId={sessionId} onResult={setResult} onNext={() => go('qr')} onError={() => setFatal(true)} />}
      {screen === 'qr'       && <QR          result={result} onDone={() => go('end')} onRestart={restart} />}
      {screen === 'end'      && <End         onRestart={restart} />}
      {screen === 'dl'       && <ProtoDownload />}
      {fatal && <ErrorOverlay />}
    </LangProvider>
  );
}
