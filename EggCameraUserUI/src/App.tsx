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
import { IdleTimeoutModal } from './components/IdleTimeoutModal';
import { QuitFlow } from './components/QuitFlow';
import { createSession, wakeCamera, selectPhoto, uploadComposite, getMode, PROTO,
         getJobStatus, reportIncident, probeRecovery, CURRENT_BUNDLE } from './api';
import type { SessionPhoto, SessionResult } from './api';
import { reportClientError } from './clientLog';
// プロト⑥プレビュー専用: 990x1485=ちょうど2:3 なのでクロップ/拡縮ゼロで
// 「横幅いっぱい」の完成イメージになる（⑩DLの proto-composed.jpg と同構図）。
import protoPreviewPhoto from './assets/baby_illustrator.png';

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
// 最終防壁: お詫び/ローカルメンテのまま復帰できない膠着がこの時間続いたら強制リロード。
// 2026-07-02/03 深夜に「撮影エラーオーバーレイ固着（自己復旧で戻らない）」が2回発生した対策。
// location.reload() は同一オリジンなのでキオスクURL(:3000)を離れない。
// 客がエラー画面の前に立ち続ける最悪時間の上限でもあるため 2 分に短縮（一次復旧
// (プローブ2連続OK→reload)が効けばそれより早く、これはあくまで膠着時の天井）。
const HARD_RELOAD_MS = 2 * 60_000;

// ── 無操作タイムアウト（途中画面で客が離脱したまま放置される問題への対策）──
// 対象は入力〜プレビューの途中画面のみ。start は待機画面そのもの、qr は自前の3分
// タイマー持ち、end は個人写真を表示しない、upload はシステム処理中のため対象外。
// 撮影画面は「赤ちゃんの顔を丸に合わせる」間タッチしない時間が長いので閾値を長く取る
// （テストハーネスの idle-pause quirk 75秒 より必ず長くすること＝誤発火防止）。
const IDLE_LIMIT_MS: Partial<Record<Screen, number>> = {
  nick: 90_000, bday: 90_000, capture: 180_000, photosel: 90_000, preview: 90_000,
};
// 確認モーダル表示からTOP復帰までのカウントダウン秒数
const IDLE_COUNTDOWN_SEC = 30;

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
        <iframe src="./proto-download.html" title="ダウンロードページ" />
      </div>
    </div>
  );
}

export default function App() {
  const [screen, setScreen]         = useState<Screen>('start');
  const [sessionId, setSessionId]   = useState<string | null>(null);
  const [nickname, setNickname]     = useState('');
  const [days, setDays]             = useState(0);
  // 満月齢（暦ベース）。フレームの区分選択に使う（日数ではなく月齢で判定する仕様）
  const [months, setMonths]         = useState(0);
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
      // 共有シートの表示・アプリ切替・画面消灯などでページが止まると、進行中の通信が
      // 中断されて unhandledrejection になる。これは端末側の一過性事象で装置の障害では
      // ないため、お詫び画面には出さない（2026-07-29: 共有ボタンを押すとお詫び画面に
      // なりホーム画面への追加ができなかった）。
      if (document.visibilityState === 'hidden') return;
      if (e instanceof PromiseRejectionEvent) {
        const r = e.reason as { name?: string; status?: number } | undefined;
        // AbortError/TimeoutError と、HTTP応答に到達せず落ちた通信(ApiError status=0)
        const transient = !!r && (r.name === 'AbortError' || r.name === 'TimeoutError' || r.status === 0);
        if (transient) {
          reportClientError(`transient rejection ignored: ${String(e.reason).slice(0, 120)}`, 'info');
          return;
        }
      }
      // クロスオリジン由来の不透明なエラー（message="Script error." でファイル名・行が空）。
      // 自分のコードに紐づけられず、Safari の共有シート表示だけでも発生する。これでお詫び
      // 画面に落ちると、ホーム画面への追加すらできない（2026-07-29に実際に発生。ログにも
      // 同時刻の [CLIENT] Script error. @:0 が連続して残っている）。記録だけして無視する。
      if (e instanceof ErrorEvent && !e.filename && !e.lineno && /^Script error\.?$/.test(e.message || '')) {
        reportClientError(`opaque script error ignored (visibility=${document.visibilityState})`, 'info');
        return;
      }
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
  // ただし撮影〜セッション進行中のリロードは、進行中の撮影シーケンスを道連れにして
  // 「孤児raw（放棄セッションの余分な1枚）」を生むため、トップ(=待機中)へ戻るまで遅延させる。
  const reloadPendingRef = useRef(false);
  const screenRef = useRef<Screen>('start');
  useEffect(() => {
    if (PROTO) return;
    const es = new EventSource('/api/events');
    es.addEventListener('settings-changed', () => {
      if (screenRef.current === 'start') location.reload();
      else reloadPendingRef.current = true; // 進行中 → トップ復帰時に反映
    });
    return () => es.close();
  }, []);
  // 画面を追跡し、遅延していた設定リロードをトップ(待機)へ戻った瞬間に実行する。
  useEffect(() => {
    screenRef.current = screen;
    if (screen === 'start' && reloadPendingRef.current) location.reload();
  }, [screen]);

  // ホーム画面追加(standalone)で開かれた時だけ、動いているビルドと全画面追従の実測を
  // 1行だけサーバへ残す。iPhone実機の画面はこちらから見られないため、白帯が出ているのか
  // 古いビルドが動いているのかをログだけで切り分けられるようにする。キオスクは standalone
  // ではないので無音。level:'info' なので障害診断のエラー検知には載らない。
  useEffect(() => {
    if (PROTO) return;
    const standalone =
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches;
    if (!standalone) return;
    const t = setTimeout(() => {
      const box = document.querySelector('.app-viewport')?.getBoundingClientRect();
      const gap = box ? Math.round(window.innerHeight - box.height) : null;
      // セーフエリア(env)の実測。下端の帯がホームインジケータ由来かを切り分ける。
      const probe = document.createElement('div');
      probe.style.cssText =
        'position:fixed;visibility:hidden;top:env(safe-area-inset-top,0px);' +
        'bottom:env(safe-area-inset-bottom,0px);height:env(safe-area-inset-bottom,0px)';
      document.body.appendChild(probe);
      const cs = getComputedStyle(probe);
      const safe = `safeTop=${cs.top} safeBottom=${cs.height}`;
      probe.remove();
      // 実画面(screen)とビューポート(inner)の差＝要素では塗れない帯。standalone では
      // ここが 0 にならない（iPad実測 1366 と 1334 で 32pt）ので、両方を残す。
      reportClientError(
        `[standalone] bundle=${CURRENT_BUNDLE || 'dev'} screen=${window.screen.width}x${window.screen.height}` +
        ` inner=${window.innerWidth}x${window.innerHeight}` +
        ` viewport=${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'none'} gap=${gap}` +
        ` outside=${Math.round(window.screen.height - window.innerHeight)} ${safe}` +
        // ウィンドウ自体の大きさと画面上の位置。帯が上下どちらに出るか、そもそも
        // ウィンドウが画面全体を占めているかを推測せずに判定するため。
        ` outer=${window.outerWidth}x${window.outerHeight} screenXY=${window.screenX},${window.screenY}` +
        ` avail=${window.screen.availWidth}x${window.screen.availHeight}`,
        'info',
      );
    }, 1200);
    return () => clearTimeout(t);
  }, []);

  // 新しいビルドが配信されたらこの端末にも取り込む。index.html は no-store だが、
  // ホーム画面追加(standalone)の webapp や常駐タブはアプリを終了しない限り再読込されず、
  // 古いバンドルのまま動き続ける（2026-07-29: 修正を反映したのに端末の表示が変わらなかった）。
  // 撮影の途中で落とさないよう、設定リロードと同じくトップ(待機)でのみ実行する。
  const applyNewBuild = (serverBundle: string) => {
    if (screenRef.current !== 'start') { reloadPendingRef.current = true; return; }
    try {
      // 同じ更新で二度リロードしない（キャッシュが居座った場合のループ防止）
      if (sessionStorage.getItem('reloadedFor') === serverBundle) return;
      sessionStorage.setItem('reloadedFor', serverBundle);
    } catch { /* sessionStorage 不可の環境ではガード無しで進む */ }
    location.reload();
  };

  // グローバルのメンテナンス状態を定期確認（mode.json 由来＝全端末ロック）。
  // 解除されたらトップへ戻す（PROTOでは常にfalse）。ローカル障害（localPhase）とは独立。
  useEffect(() => {
    if (PROTO) return;
    let prev = false;
    const check = () => {
      getMode()
        .then(({ maintenance: m, serverCompose: sc, bundle }) => {
          setMaintenance(m);
          setServerCompose(!!sc);
          if (prev && !m) { restart(); } // 解除された瞬間にトップへ
          prev = m;
          if (bundle && CURRENT_BUNDLE && bundle !== CURRENT_BUNDLE) applyNewBuild(bundle);
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
      // 2回連続OK→復帰（一過性ブレ除け）。状態復元(restart)ではなくページ再読込で確実に
      // 初期化する（エラー経路で残った部品の状態・タイマーごと捨てる＝固着の再発防止）。
      if (okStreak >= 2) { location.reload(); return; }
      timer = setTimeout(tick, RECOVERY_RETRY_MS);
    };
    timer = setTimeout(tick, 1_500);
    return () => { stopped = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localPhase]);

  // 最終防壁: お詫び(fatal)またはローカルメンテ(localPhase)のまま HARD_RELOAD_MS を超えたら
  // 無条件で再読込。プローブループの停止・タイマー喪失など想定外の膠着でも必ずTOPへ戻す。
  // 状態が遷移(fatal→recovering)するとタイマーは仕切り直し＝正常な復旧フローは妨げない。
  // バックエンド障害が続く場合は再読込後も LocalMaintenance に入り直すだけで無害。
  useEffect(() => {
    if (PROTO) return;
    if (!fatal && localPhase === 'none') return;
    const t = setTimeout(() => location.reload(), HARD_RELOAD_MS);
    return () => clearTimeout(t);
  }, [fatal, localPhase]);

  // 無操作タイムアウト: 対象画面で一定時間タッチが無ければ確認モーダル（カウントダウン）を出し、
  // それでも操作が無ければ restart() でTOPへ。どこかをタップすれば pointerdown で即リセット
  // （モーダルも閉じる）。放棄セッションの撮りかけ raw は既存の孤児GCが回収する。
  // idleLeft: null=平常 / 数値=モーダル表示中の残り秒数
  const [idleLeft, setIdleLeft] = useState<number | null>(null);
  useEffect(() => {
    if (PROTO) return;
    const limit = IDLE_LIMIT_MS[screen];
    if (!limit || fatal || localPhase !== 'none' || maintenance) { setIdleLeft(null); return; }
    let idleTimer: ReturnType<typeof setTimeout>;
    let countTimer: ReturnType<typeof setInterval> | undefined;
    const clearAll = () => {
      clearTimeout(idleTimer);
      if (countTimer) { clearInterval(countTimer); countTimer = undefined; }
    };
    const arm = () => {
      clearAll();
      setIdleLeft(null);
      idleTimer = setTimeout(() => {
        let left = IDLE_COUNTDOWN_SEC;
        setIdleLeft(left);
        countTimer = setInterval(() => {
          left -= 1;
          if (left <= 0) { clearAll(); setIdleLeft(null); restart(); }
          else setIdleLeft(left);
        }, 1000);
      }, limit);
    };
    // click も見る: 実タッチは pointerdown で拾えるが、テストハーネス等の合成 click は
    // pointerdown を発火しないため（element.click() は click のみ）。
    window.addEventListener('pointerdown', arm);
    window.addEventListener('click', arm);
    arm();
    return () => {
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('click', arm);
      clearAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, fatal, localPhase, maintenance]);

  const go = (s: Screen) => setScreen(s);

  const goCapture = (d: number, m = 0) => {
    setDays(d);
    setMonths(m);
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
    })().catch(err => {
      // 判定用API(getJobStatus/reportIncident)の一過性失敗を unhandledrejection→triggerFatal に
      // 落とさない。ジョブ自体は worker が裏で継続するので、そのままトップへ戻すのが安全側。
      reportClientError(`endSession check failed: ${err}`);
      setPendingJob(null);
      setLocalPhase('none');
      restart();
    });
  };

  const restart = () => {
    setNickname('');
    setDays(0);
    setMonths(0);
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
      {/* 撮影画面(Capture)のライブ映像立ち上がりが遅く感じられるため、ニックネーム/生年月日
          入力中(＝撮影の1〜2画面前)から裏でプレビュー取得を先行させ、node側のキャッシュと
          取得ループを温めておく。Capture側の <img src="/api/preview/stream"> が接続した瞬間、
          直近フレーム(3秒以内なら)を即返すのでコールドスタート待ちが解消される
          （src/preview.js streamFrames の STALE_MS キャッシュ利用）。表示はしないため
          display:none で置くだけでよく、失敗しても無視してよい(Captureが自前で再接続する)。 */}
      {!PROTO && (screen === 'nick' || screen === 'bday') && (
        <img src="/api/preview/stream" alt="" aria-hidden style={{ display: 'none' }} />
      )}
      {screen === 'start'    && <Start       onNext={() => { wakeCamera().catch(() => {}); go('nick'); }} />}
      {screen === 'nick'     && <Nickname    nickname={nickname} onChange={setNickname} onNext={() => go('bday')} onSkip={() => go('bday')} />}
      {screen === 'bday'     && <Birthday    nickname={nickname} onNext={goCapture} onSkip={() => goCapture(0, 0)} />}
      {screen === 'capture'  && <Capture     sessionId={sessionId} onComplete={photos => { setPhotos(photos); go('photosel'); }} onError={() => triggerFatal('capture error')} />}
      {screen === 'photosel' && <PhotoSelect photos={photos} onNext={photoId => { setSelectedPhotoId(photoId); go('preview'); }} onBack={retake} />}
      {screen === 'preview'  && (serverCompose
        ? <FinalPreviewServer
            sessionId={sessionId} photoId={selectedPhotoId} nickname={nickname} days={days} months={months}
            onConfirmed={(r, jobId) => { setResult(r); setPendingJob({ jobId }); go('qr'); }}
            onError={() => triggerFatal('server-compose error')} />
        : <FinalPreview nickname={nickname} days={days}
            photoUrl={PROTO ? protoPreviewPhoto : (selectedPhoto?.url ?? '')}
            onNext={goUpload} />)}
      {screen === 'upload'   && <Uploading   sessionId={sessionId} onResult={setResult} onNext={() => go('qr')} onError={() => triggerFatal('upload error')} />}
      {screen === 'qr'       && <QR          result={result} onDone={() => go('end')} onRestart={endSession} />}
      {screen === 'end'      && <End         onRestart={endSession} onShowQr={result ? () => go('qr') : undefined} />}
      {screen === 'dl'       && <ProtoDownload />}
      {/* 手動リセット: 無操作タイムアウトと同じ途中画面に「最初に戻る」を出す。
          必ず画面コンポーネントより後に置く（DOM先頭ボタン=シャッター等の前提を守る）。
          key={screen} で画面遷移時に確認ダイアログの開き残りを捨てる。 */}
      {IDLE_LIMIT_MS[screen] !== undefined && <QuitFlow key={screen} onRestart={restart} />}
      {idleLeft !== null     && <IdleTimeoutModal secondsLeft={idleLeft} />}
      {localPhase !== 'none' && <LocalMaintenance phase={localPhase} />}
      {maintenance && <MaintenanceLock />}
      {fatal && <ErrorOverlay />}
    </LangProvider>
  );
}
