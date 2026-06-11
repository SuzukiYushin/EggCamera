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
import { FRAMES }       from './data/frames';
import { createSession, selectPhoto, uploadComposite } from './api';
import type { SessionPhoto, SessionResult } from './api';

type Screen = 'start' | 'nick' | 'bday' | 'capture' | 'photosel' | 'preview' | 'upload' | 'qr' | 'end';

export default function App() {
  const [screen, setScreen]         = useState<Screen>('start');
  const [sessionId, setSessionId]   = useState<string | null>(null);
  const [nickname, setNickname]     = useState('');
  const [days, setDays]             = useState(0);
  const [frameId, setFrameId]       = useState('');
  const [frameLabel, setFrameLabel] = useState('');
  const [photos, setPhotos]         = useState<SessionPhoto[]>([]);
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null);
  const [result, setResult]         = useState<SessionResult | null>(null);
  const [compositeBlob, setCompositeBlob] = useState<Blob | null>(null);

  useEffect(() => {
    createSession()
      .then(({ sessionId }) => setSessionId(sessionId))
      .catch(err => console.error('createSession failed', err));
  }, []);

  const go = (s: Screen) => setScreen(s);

  const goCapture = (d: number) => {
    const frame = FRAMES[Math.floor(Math.random() * FRAMES.length)];
    setDays(d);
    setFrameId(frame.id);
    setFrameLabel(frame.label);
    go('capture');
  };

  const retake = () => {
    setPhotos([]);
    setSelectedPhotoId(null);
    createSession()
      .then(({ sessionId }) => setSessionId(sessionId))
      .catch(err => console.error('createSession failed', err));
    go('capture');
  };

  const goUpload = (blob: Blob) => {
    setCompositeBlob(blob);
    if (sessionId && selectedPhotoId) {
      selectPhoto(sessionId, { photoId: selectedPhotoId, frameId, nickname, days })
        .catch(err => console.error('selectPhoto failed', err));
    }
    if (sessionId) {
      uploadComposite(sessionId, blob).catch(err => console.error('uploadComposite failed', err));
    }
    go('upload');
  };

  const retryUpload = () => {
    if (sessionId && compositeBlob) {
      uploadComposite(sessionId, compositeBlob).catch(err => console.error('uploadComposite failed', err));
    }
  };

  const restart = () => {
    setNickname('');
    setDays(0);
    setFrameId('');
    setFrameLabel('');
    setPhotos([]);
    setSelectedPhotoId(null);
    setResult(null);
    setCompositeBlob(null);
    createSession()
      .then(({ sessionId }) => setSessionId(sessionId))
      .catch(err => console.error('createSession failed', err));
    go('start');
  };

  const selectedPhoto = photos.find(p => p.photoId === selectedPhotoId);

  return (
    <LangProvider>
      {screen === 'start'    && <Start       onNext={() => go('nick')} />}
      {screen === 'nick'     && <Nickname    nickname={nickname} onChange={setNickname} onNext={() => go('bday')} onSkip={() => go('bday')} />}
      {screen === 'bday'     && <Birthday    nickname={nickname} onNext={goCapture} onSkip={() => goCapture(0)} />}
      {screen === 'capture'  && <Capture     sessionId={sessionId} onComplete={photos => { setPhotos(photos); go('photosel'); }} />}
      {screen === 'photosel' && <PhotoSelect photos={photos} onNext={photoId => { setSelectedPhotoId(photoId); go('preview'); }} onBack={retake} />}
      {screen === 'preview'  && <FinalPreview nickname={nickname} days={days} frameLabel={frameLabel} photoUrl={selectedPhoto?.url ?? ''} onNext={goUpload} />}
      {screen === 'upload'   && <Uploading   sessionId={sessionId} onResult={setResult} onNext={() => go('qr')} onRetry={retryUpload} />}
      {screen === 'qr'       && <QR          result={result} onDone={() => go('end')} onRestart={restart} />}
      {screen === 'end'      && <End         onRestart={restart} />}
    </LangProvider>
  );
}
