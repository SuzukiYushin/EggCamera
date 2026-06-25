import { useState, useEffect, useRef } from 'react';
import './styles/global.css';
import { LangProvider } from './LangContext';
import { Start }        from './components/screens/Start';
import { Nickname }     from './components/screens/Nickname';
import { Birthday }     from './components/screens/Birthday';
import { Capture }      from './components/screens/Capture';
import { PhotoSelect }  from './components/screens/PhotoSelect';
import { FinalPreview } from './components/screens/FinalPreview';
import { FinalPreviewServer } from './components/screens/FinalPreviewServer';
import { Uploading }    from './components/screens/Uploading';
import { QR }           from './components/screens/QR';
import { End }          from './components/screens/End';
import { ErrorOverlay } from './components/ErrorOverlay';
import { MaintenanceLock } from './components/MaintenanceLock';
import { LocalMaintenance } from './components/LocalMaintenance';
import { createSession, wakeCamera, selectPhoto, uploadComposite, getMode, PROTO,
         getJobStatus, reportIncident, probeRecovery } from './api';
import type { SessionPhoto, SessionResult } from './api';
import { reportClientError } from './clientLog';

type Screen = 'start' | 'nick' | 'bday' | 'capture' | 'photosel' | 'preview' | 'upload' | 'qr' | 'end' | 'dl';

// ローカル障害フェーズ（この端末のエラー起因。グローバルmaintenance=全端末ロックとは別物）。
//   none       … 平常
//   recovering … 系統A/重症B: 裏で selftest を回して自己復旧を待つ（回復→トップ）
//   diagnosing … 系統B: アップロード未解消の切り分け中（短時間）
type LocalPhase = 'none' | 'recovering' | 'diagnosing';

// お詫び（ErrorOverlay）を見せてからメンテ画面へ移すまでの猶予
const APOLOGY_MS = 15_000;
// 自己復旧プローブの間隔（軽量＝実撮影しないので短めでよい）
const RECOVERY_RETRY_MS = 5_000;

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
  const [maintenance, setMaintenance] = useState(false);
  // サーバ側合成フローを使うか（/api/mode の serverCompose で切替。既定=旧canvas合成）
  const [serverCompose, setServerCompose] = useState(false);
  // ローカル障害フェーズと、系統Bで完了確認する対象ジョブ
  const [localPhase, setLocalPhase] = useState<LocalPhase>('none');
  const [pendingJob, setPendingJob] = useState<{ jobId: string } | null>(null);
  // 致命エラー処理の二重起動ガード（複数のエラーが同時に飛んでも1回だけ処理する）
  const handlingRef = useRef(false);

  // createSession の世代管理。リロード直後のマウント生成と retake/restart の生成が
  // 競合したとき、解決順が逆転して「古い session」を掴むのを防ぐ。常に最新要求だけ採用。
  const sessionGen = useRef(0);
  const newSession = () => {
    const gen = ++sessionGen.current;
    return createSession()
      .then(({ sessionId }) => {
        if (gen === sessionGen.current) setSessionId(sessionId); // 最新だけ採用
        return sessionId;
      })
      .catch(err => { triggerFatal(`createSession failed: ${err}`); return null; });
  };

  // 致命エラー（系統A）: お詫びを数秒見せてから、トップではなくメンテ画面へ移し、
  // 裏で自己復旧（selftest）を試みる。原因はサーバログ＋管理画面（incident通知）に残す。
  const triggerFatal = (detail: string) => {
    if (handlingRef.current) return;      // 既に障害対応中なら無視
    handlingRef.current = true;
    reportClientError(detail);
    reportIncident({ kind: 'fatal', detail, sessionId });
    setFatal(true);
    setTimeout(() => { setFatal(false); setLocalPhase('recovering'); }, APOLOGY_MS);
  };

  // 想定外のJSエラー（捕捉漏れ）も系統Aに乗せる。描画中の例外は ErrorBoundary が別途担当。
  useEffect(() => {
    const onError = (e: Event) => {
      const detail = e instanceof ErrorEvent
        ? `${e.message} @${e.filename}:${e.lineno}`
        : e instanceof PromiseRejectionEvent
          ? `unhandledrejection: ${e.reason}`
          : 'unknown error';
      triggerFatal(detail);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onError);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    newSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 管理画面で設定が変更されたらページをリロード（SSE push）。EventSource は標準で自動再接続する。
  useEffect(() => {
    if (PROTO) return;
    const es = new EventSource('/api/events');
    es.addEventListener('settings-changed', () => location.reload());
    return () => es.close();
  }, []);

  // グローバルのメンテナンス状態を定期確認（mode.json 由来＝全端末ロック）。
  // 解除されたらトップへ戻す（PROTOでは常にfalse）。ローカル障害（localPhase）とは独立。
  useEffect(() => {
    if (PROTO) return;
    let prev = false;
    const check = () => {
      getMode()
        .then(({ maintenance: m, serverCompose: sc }) => {
          setMaintenance(m);
          setServerCompose(!!sc);
          if (prev && !m) { restart(); } // 解除された瞬間にトップへ
          prev = m;
        })
        .catch(() => {});
    };
    check();
    const t = setInterval(check, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 系統A/重症B の自己復旧ループ: localPhase==='recovering' の間、軽量プローブ
  // （カメラ=プレビュー生存＋サーバ応答）を回し、2回連続OKでトップへ復帰する。
  // 実撮影はしない＝復旧確認でシャッターを切らないので、カメラ不安定時に多重撮影を誘発しない。
  // 深いパイプライン検証（実撮影selftest）は管理者/watchdog側に委ねる。
  useEffect(() => {
    if (PROTO) return;
    if (localPhase !== 'recovering') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let okStreak = 0;
    const tick = async () => {
      if (stopped) return;
      const r = await probeRecovery();
      if (stopped) return;
      okStreak = r.ok ? okStreak + 1 : 0;
      if (okStreak >= 2) { restart(); return; } // 2回連続OK→復帰（一過性ブレ除け）。restartがlocalPhaseもnoneに
      timer = setTimeout(tick, RECOVERY_RETRY_MS);
    };
    timer = setTimeout(tick, 1_500);
    return () => { stopped = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localPhase]);

  const go = (s: Screen) => setScreen(s);

  const goCapture = (d: number) => {
    // フレームは FinalPreview が /api/frames から都度ランダム選択する
    setDays(d);
    go('capture');
  };

  const retake = () => {
    setPhotos([]);
    setSelectedPhotoId(null);
    // 新session確定まで sessionId を null にし、Capture の撮影ボタンを抑止する
    setSessionId(null);
    newSession();
    go('capture');
  };

  const goUpload = (blob: Blob) => {
    // session が無い状態で保存に来たら黙って進めず即エラーに倒す
    if (!sessionId) {
      triggerFatal('goUpload without sessionId');
      return;
    }
    if (selectedPhotoId) {
      // メタデータ記録のみ。失敗しても合成画像のアップロードには影響しない
      selectPhoto(sessionId, { photoId: selectedPhotoId, nickname, days })
        .catch(err => console.error('selectPhoto failed', err));
    }
    uploadComposite(sessionId, blob)
      .catch(err => { triggerFatal(`uploadComposite failed: ${err}`); });
    go('upload');
  };

  // セッション終了（QRで「トップ」/ Endの自動タイムアウト）時の処理（系統B）。
  // 確定済みジョブのアップロードがまだ完了していなければ、メンテ画面で切り分けを行う。
  const endSession = () => {
    const job = pendingJob;
    if (!job) { restart(); return; }     // サーバ合成以外（旧フロー等）は追跡なし
    setLocalPhase('diagnosing');
    (async () => {
      const st = await getJobStatus(job.jobId);
      // done＝完了 / attempts<1＝まだ正常に進行中（worker未失敗）→ どちらも通常どおりトップへ。
      // （QR表示直後にトップを押した正常ケースを「詰まり」と誤検知しないための条件）
      if (st.done || st.attempts < 1) {
        setPendingJob(null); setLocalPhase('none'); restart();
        return;
      }
      // 明確に詰まっている（worker が1回以上失敗）→ サーバへ報告して指示を仰ぐ。
      const inc = await reportIncident({ kind: 'upload-stuck', jobId: job.jobId, sessionId });
      setPendingJob(null);
      if (inc.action === 'recover') {
        // 1回目＋回線正常 → 画像固有とみなしトップへ復帰
        setLocalPhase('none'); restart();
      } else {
        // maintain-restart（2連続）/ wait-network（回線異常）→ メンテ画面に留まり自己復旧へ。
        // 管理画面への再起動通知はサーバ側(incident)で送信済み。
        setLocalPhase('recovering');
      }
    })();
  };

  const restart = () => {
    setNickname('');
    setDays(0);
    setPhotos([]);
    setSelectedPhotoId(null);
    setResult(null);
    setSessionId(null);
    setPendingJob(null);
    setFatal(false);
    setLocalPhase('none');
    handlingRef.current = false;
    newSession();
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
      {screen === 'start'    && <Start       onNext={() => { wakeCamera().catch(() => {}); go('nick'); }} />}
      {screen === 'nick'     && <Nickname    nickname={nickname} onChange={setNickname} onNext={() => go('bday')} onSkip={() => go('bday')} />}
      {screen === 'bday'     && <Birthday    nickname={nickname} onNext={goCapture} onSkip={() => goCapture(0)} />}
      {screen === 'capture'  && <Capture     sessionId={sessionId} onComplete={photos => { setPhotos(photos); go('photosel'); }} onError={() => triggerFatal('capture error')} />}
      {screen === 'photosel' && <PhotoSelect photos={photos} onNext={photoId => { setSelectedPhotoId(photoId); go('preview'); }} onBack={retake} />}
      {screen === 'preview'  && (serverCompose
        ? <FinalPreviewServer
            sessionId={sessionId} photoId={selectedPhotoId} nickname={nickname} days={days}
            onConfirmed={(r, jobId) => { setResult(r); setPendingJob({ jobId }); go('qr'); }}
            onError={() => triggerFatal('server-compose error')} />
        : <FinalPreview nickname={nickname} days={days} photoUrl={selectedPhoto?.url ?? ''} onNext={goUpload} />)}
      {screen === 'upload'   && <Uploading   sessionId={sessionId} onResult={setResult} onNext={() => go('qr')} onError={() => triggerFatal('upload error')} />}
      {screen === 'qr'       && <QR          result={result} onDone={() => go('end')} onRestart={endSession} />}
      {screen === 'end'      && <End         onRestart={endSession} />}
      {screen === 'dl'       && <ProtoDownload />}
      {localPhase !== 'none' && <LocalMaintenance phase={localPhase} />}
      {maintenance && <MaintenanceLock />}
      {fatal && <ErrorOverlay />}
    </LangProvider>
  );
}
