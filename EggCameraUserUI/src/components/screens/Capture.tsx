import { useState, useEffect, useRef } from 'react';
import { IPad } from '../IPad';
import { useLang } from '../../LangContext';
import { capturePhoto, ApiError, PROTO } from '../../api';
import type { SessionPhoto } from '../../api';
import { reportClientError } from '../../clientLog';
import { ParticleEl, makeBurst, CANVAS_REACH, type Burst } from '../ParticleBurst';
import { FINAL_ASPECT, computePlacement, type PreviewPlacement } from '../../cropPlacement';
import babyImg from '../../assets/baby_illustrator.png';

interface CaptureProps {
  sessionId: string | null;
  onComplete: (photos: SessionPhoto[]) => void;
  // 失敗コードを渡す。session_not_found のように「装置は正常でセッションだけ切れた」
  // ケースを、親側でお詫び画面ではなく通常の復帰として扱えるようにする。
  onError: (code?: string) => void;
}

const MAX_SHOTS = 3;
const SHOT_INTERVAL = 600;

const PARTICLE_COLORS = [
  '#4C9BF0', '#5B8EDB', '#3E7FC1', '#6FA8DC',
  '#4ADE80', '#34D399', '#22C55E', '#6EE7B7',
  '#FFD166', '#FBBF24', '#FDE047', '#EAB308',
];

// 飛距離は画面（＝設計キャンバス）の中心〜四隅を基準にした比率で決める。実寸pxを直接
// 書くと端末や出力解像度が変わったときに「画面いっぱい」にならない。
const shotBurst = () => makeBurst({
  colors: PARTICLE_COLORS,
  count: 24,
  dist: [CANVAS_REACH * 0.6, CANVAS_REACH * 0.7],   // 中心から四隅の 60〜130%
  size: [CANVAS_REACH * 0.05, CANVAS_REACH * 0.055],
  duration: [700, 350], delayMax: 60, jitterDeg: 18,
});

// ── iPhoneのリアルタイム映像 ───────────────────────────────────────
// 既定は MJPEG ストリーム(/api/preview/stream)を <img> で直接表示する（1接続=高頻度
// ポーリング不要）。MJPEG 非対応ブラウザ(iOS Safari 等)では単写真ポーリングへ自動で
// フォールバックする。フォールバック先の /api/preview/frame も node 側キャッシュを返すため、
// どちらでも iPhone:8080 への取得は node の単一ループ1本に集約される（高頻度の直撃を避ける）。
// 取得できない間は同梱イラストにフォールバックし、自動で再接続を試みる。
const PREVIEW_INTERVAL_MS = 333; // poll フォールバックは ~3fps に抑制（MJPEG非対応時のみ使用）
const PREVIEW_RETRY_MS = 1500;
const STREAM_LOAD_TIMEOUT_MS = 2500; // この間に1枚も表示されなければ MJPEG 非対応とみなし poll へ

// 完成画像のアスペクト比・プレビュー比・切り抜き上限は src/cropPlacement.ts に集約
// （写真選択のサムネイルと同じ切り出しを見せるため）。FINAL_ASPECT は import 済み。

// ライブビュー枠の上下マージン（設計キャンバス768x1024基準。青地が上下に見える）。
// 枠の高さは 1024-(上+下) で決まり、差を付けると枠ごと上下に動く。
const LIVE_MARGIN_TOP    = 80;    // 100 から 20px 上へ
const LIVE_MARGIN_BOTTOM = 120;
// シャッターボタンのキャンバス下端からの距離
const SHUTTER_BOTTOM = 33;   // 36 から 3px 下へ
// 撮影進捗（ドット3つ＋「n枚目を撮影中…」）のキャンバス下端からの距離
const SHOT_PROGRESS_BOTTOM = 128;
// 顔合わせガイドの既定縦位置（ライブビュー枠の高さに対する%）。管理画面から変更できる。
const GUIDE_TOP_DEFAULT = 13;
// ガイドの大きさもライブビュー枠に対する比率で持つ。管理画面のプレビュー(admin.js の
// GUIDE_W_PCT/GUIDE_H_PCT)と同じ値にすること。ズレると現場の見え方と食い違う。
const GUIDE_W_PCT = 48.8;
// 管理画面での調整を撮影画面へ反映する間隔。小さなJSONの取得なので負荷は無視できる。
const SETTINGS_POLL_MS = 2000;
const GUIDE_H_PCT = 25.2;

// ライブ映像の配置ロジックは写真選択のサムネイルと共用する（src/cropPlacement.ts）。
// 片方だけ直すと「ライブビューで見えた範囲」と「選んだ写真の仕上がり」がズレるため。

interface LiveCameraViewProps {
  // ライブ映像を実際に表示できているかを親へ通知する。プロト時は常に true
  // （同梱イラストはプロト仕様であり未接続エラーではないため）。
  onReadyChange: (ready: boolean) => void;
  // 合成の切り出し(trim/offsetX/offsetY)を反映した配置。
  placement: PreviewPlacement;
}

function LiveCameraView({ onReadyChange, placement }: LiveCameraViewProps) {
  const imgStyle = { position: 'absolute' as const, display: 'block', ...placement };
  // 'stream' = MJPEG / 'poll' = 単写真ポーリング(MJPEG非対応の fallback)
  const [mode, setMode] = useState<'stream' | 'poll'>('stream');
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const streamLoaded = useRef(false);

  useEffect(() => {
    if (PROTO) onReadyChange(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // MJPEG が規定時間内に1枚も表示されなければ poll へ切替（iOS Safari 等の非対応対策）
  useEffect(() => {
    if (PROTO || mode !== 'stream') return;
    streamLoaded.current = false;
    const t = setTimeout(() => { if (!streamLoaded.current) setMode('poll'); }, STREAM_LOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [mode]);

  // poll フォールバック（/api/preview/frame は node 側キャッシュ＝iPhone へ直撃しない）
  useEffect(() => {
    if (PROTO || mode !== 'poll') return;
    let cancelled = false;
    let prevUrl: string | null = null;
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    (async () => {
      while (!cancelled) {
        const t0 = Date.now();
        try {
          const res = await fetch('/api/preview/frame', { cache: 'no-store' });
          if (!res.ok) throw new Error(`status ${res.status}`);
          if (!res.headers.get('content-type')?.startsWith('image/')) {
            throw new Error('not an image'); // SPAフォールバック等のHTML応答を弾く
          }
          const blob = await res.blob();
          if (cancelled) break;
          const url = URL.createObjectURL(blob);
          setFrameUrl(url);
          onReadyChange(true);
          if (prevUrl) URL.revokeObjectURL(prevUrl);
          prevUrl = url;
          await sleep(Math.max(0, PREVIEW_INTERVAL_MS - (Date.now() - t0)));
        } catch {
          if (cancelled) break;
          setFrameUrl(null); // イラストにフォールバック
          onReadyChange(false); // 準備中メッセージ表示＋シャッター無効化。ループは継続し自動リトライ
          await sleep(PREVIEW_RETRY_MS);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (prevUrl) URL.revokeObjectURL(prevUrl);
    };
  }, [mode, onReadyChange]);

  if (!PROTO && mode === 'stream') {
    return (
      <img
        src="/api/preview/stream"
        alt="camera preview"
        onLoad={() => { streamLoaded.current = true; onReadyChange(true); }}
        onError={() => { onReadyChange(false); setMode('poll'); }}
        style={imgStyle}
      />
    );
  }

  if (!PROTO && mode === 'poll' && frameUrl) {
    return <img src={frameUrl} alt="camera preview" style={imgStyle} />;
  }

  // フォールバック（プロトタイプ / iPhone未接続・プレビュー取得失敗時）
  return (
    <img
      src={babyImg}
      alt="camera preview"
      style={{
        position: 'absolute', top: '50%', left: '47%',
        transform: 'translate(-49%, -48%)',
        width: '105%', height: '105%', objectFit: 'cover', display: 'block',
      }}
    />
  );
}

export function Capture({ sessionId, onComplete, onError }: CaptureProps) {
  const { T } = useLang();
  const [photos, setPhotos] = useState<SessionPhoto[]>([]);
  const [flashKey, setFlashKey] = useState(0);
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [started, setStarted] = useState(false);
  // ライブ映像を実際に表示できているか（プロトは常に true）。false の間はシャッターを
  // 無効化し「準備中」を表示する。true/false 待ちを繰り返してもプレビュー側が自動リトライを続ける。
  const [cameraReady, setCameraReady] = useState(false);
  // 合成の横pan(crop.offsetX)をライブビューにも反映するための objectPosition。
  // 縦(offsetY)はプレビュー・raw とも縦全高が写るため合成側で常に効かず、反映不要。
  const [placement, setPlacement] = useState<PreviewPlacement>(() => computePlacement(0, 0, 0));
  // 顔合わせガイド(破線の丸)の縦位置。管理画面の設定値(ライブビュー枠の高さに対する%)。
  const [guideTop, setGuideTop] = useState(GUIDE_TOP_DEFAULT);

  // 設定は撮影画面にいる間ずっと見張る。管理画面でガイド位置やpanを動かしたとき、
  // 保存のたびにキオスクを再読込しなくても数秒で反映される（現場での調整を往復なしで行う）。
  useEffect(() => {
    if (PROTO) return;
    let cancelled = false;
    const apply = async () => {
      try {
        const res = await fetch('/api/settings', { cache: 'no-store' });
        const s = await res.json();
        if (cancelled) return;
        setPlacement(computePlacement(
          Number(s?.crop?.trim) || 0,
          Number(s?.crop?.offsetX) || 0,
          Number(s?.crop?.offsetY) || 0,
        ));
        const g = Number(s?.guide?.top);
        if (Number.isFinite(g)) setGuideTop(g);
      } catch { /* 取得失敗時は前回値のまま。次のポーリングで復帰する */ }
    };
    apply();
    const t = setInterval(apply, SETTINGS_POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, []);
  // 連打の即時ガード。started(state)は再描画後にしか反映されず、撮影ボタンを高速連打すると
  // 再描画前に shoot() が複数走って余計なシャッターが鳴る。ref は同期で即反映されるので隙が無い。
  const startedRef = useRef(false);

  const canShoot = !!sessionId && !started && cameraReady && photos.length < MAX_SHOTS;

  // iPhoneのシャッターはトリガー送信の直後に切れる（レスポンスはHEIC転送・変換後で
  // 数秒遅れる）ので、エフェクトは完了を待たず送信直後+補正分の遅延で発火させる
  const FX_DELAY_MS = 400;

  const fireShotEffect = () => {
    setFlashKey(k => k + 1);
    const burst = shotBurst();
    setBursts(b => [...b, burst]);
    setTimeout(() => setBursts(b => b.filter(x => x.id !== burst.id)), 900);
  };

  const shoot = async () => {
    if (startedRef.current || !canShoot || !sessionId) return; // refで即時に二重起動を塞ぐ
    startedRef.current = true;
    setStarted(true);

    const acc = [...photos];
    while (acc.length < MAX_SHOTS) {
      const fxTimer = setTimeout(fireShotEffect, FX_DELAY_MS);
      try {
        const photo = await capturePhoto(sessionId);
        acc.push(photo);
        setPhotos([...acc]);
        if (acc.length < MAX_SHOTS) {
          await new Promise(r => setTimeout(r, SHOT_INTERVAL));
        }
      } catch (err) {
        clearTimeout(fxTimer); // 失敗時はエフェクトを出さない（即時エラーの場合）
        // 撮影エラーは全画面共通のお詫びオーバーレイへ（自動リロードで復帰）
        const code = err instanceof ApiError ? err.code : 'capture_failed';
        reportClientError(`capture failed: ${code} (shot ${acc.length + 1}/3)`);
        onError(code);
        return;
      }
    }
    setTimeout(() => onComplete(acc), 700);
  };

  const shutterLabel = started ? T.capture.capturing : T.capture.shutter;

  return (
    <IPad step={3} totalSteps={5} animKey="capture">
      {/* Full-bleed camera view。ライブビュー枠(完成画像比)の左右余白はトップページと同じ青 */}
      <div data-section="camera-screen" style={{ flex: 1, position: 'relative', overflow: 'hidden', background: 'var(--color-brand-500)' }}>

        {/* iPhoneのリアルタイム映像（未接続時はイラストにフォールバック＋準備中表示）。
            完成画像(2768:6000)と同じ範囲だけを見せる枠に収める。枠外(左右)は合成で
            捨てられる領域のため、見せると「写ると思ったのに切れた」事故になる。 */}
        <div style={{
          position: 'absolute', top: LIVE_MARGIN_TOP, bottom: LIVE_MARGIN_BOTTOM, left: '50%',
          transform: 'translateX(-50%)',
          aspectRatio: String(FINAL_ASPECT),
          overflow: 'hidden',
        }}>
          <LiveCameraView onReadyChange={setCameraReady} placement={placement} />

          {/* 顔合わせガイド(破線の丸)。位置・大きさはライブビュー枠に対する比率で持つ
              （管理画面のプレビューも同じ比率で描くので、見た目が一致する）。
              縦位置は管理画面から変更でき、保存すると数秒で反映される。 */}
          <div style={{
            position: 'absolute',
            top: `${guideTop}%`, left: '50%',
            transform: 'translateX(-50%)',
            width: `${GUIDE_W_PCT}%`, height: `${GUIDE_H_PCT}%`,
            borderRadius: '50%',
            border: '6.5px dashed var(--color-brand-500)',
            pointerEvents: 'none',
            opacity: 0.85,
            boxSizing: 'border-box',
          }} />
        </div>

        {/* カメラ準備中（未接続/再接続中）: シャッター無効化と合わせて状態を正直に伝える */}
        {!cameraReady && (
          <div style={{
            position: 'absolute', top: 84, left: '50%', transform: 'translateX(-50%)',
            padding: '10px 20px', borderRadius: 999,
            background: 'rgba(6,35,111,0.78)',
            fontFamily: "var(--font-ui)", fontSize: 14, fontWeight: 600,
            color: '#fff', textAlign: 'center', whiteSpace: 'pre-line', lineHeight: 1.4,
            pointerEvents: 'none',
          }}>
            {T.capture.cameraPreparing}
          </div>
        )}

        {/* Instruction text at top */}
        <div style={{
          position: 'absolute', top: 39, left: 0, right: 0,   // 44 から 5px 上へ
          textAlign: 'center',
          fontFamily: "var(--font-ui)", fontSize: 18, fontWeight: 700,
          color: '#06236F',
          letterSpacing: '0.1em',
        }}>
          {T.capture.instruction}
        </div>

        {/* Shutter flash overlay */}
        <div key={flashKey} style={{
          position: 'absolute', inset: 0,
          background: 'rgba(255,255,255,0)',
          animation: flashKey === 0 ? 'none' : 'shutterFlash 0.35s ease-out',
          pointerEvents: 'none',
        }} />

        {/* Particle bursts */}
        {bursts.map(burst => (
          <div key={burst.id} style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
          }}>
            {burst.particles.map((p, i) => <ParticleEl key={i} {...p} />)}
          </div>
        ))}

        {/* Shot progress — 連写シーケンス中の無言区間をなくす（ドット＋「n枚目を撮影中…」）。
            1枚あたりサーバ応答に数秒かかるため、タップ直後から常時表示して固まった印象を防ぐ。 */}
        {(started || photos.length > 0) && (
          <div style={{
            position: 'absolute', bottom: SHOT_PROGRESS_BOTTOM, left: 0, right: 0,
            textAlign: 'center', pointerEvents: 'none',
          }}>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginBottom: 6 }}>
              {Array.from({ length: MAX_SHOTS }, (_, i) => (
                <div key={i} style={{
                  width: 12, height: 12, borderRadius: '50%',
                  background: i < photos.length ? '#FF3B30' : 'rgba(6,35,111,0.25)',
                  transition: 'background 0.3s ease',
                }} />
              ))}
            </div>
            <div style={{
              fontFamily: "var(--font-ui)", fontSize: 15, fontWeight: 600,
              color: '#FF3B30',
            }}>
              {photos.length >= MAX_SHOTS
                ? T.capture.allShotsDone
                : started
                  ? T.capture.shootingNth(photos.length + 1)
                  : `${photos.length} / ${MAX_SHOTS}`}
            </div>
          </div>
        )}

        {/* Circular shutter button — outer navy ring + inner blue circle with label */}
        <div style={{
          position: 'absolute', bottom: SHUTTER_BOTTOM, left: '50%',
          transform: 'translateX(-50%)',
        }}>
          <button
            data-ui="shutter-btn"
            onClick={shoot}
            disabled={!canShoot}
            style={{
              width: 76, height: 76,
              borderRadius: '50%',
              border: 'none',
              background: canShoot ? '#06236F' : 'rgba(6,35,111,0.35)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: canShoot ? 'pointer' : 'not-allowed',
              padding: 0,
              boxShadow: canShoot ? '0 4px 24px rgba(81,143,204,0.55)' : 'none',
              transition: 'transform 0.2s ease, box-shadow 0.2s ease, opacity 0.2s',
            }}
          >
            <div style={{
              width: 61, height: 61,
              borderRadius: '50%',
              background: canShoot ? 'var(--color-brand-500)' : 'rgba(81,143,204,0.4)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.2s',
              fontFamily: "var(--font-ui)", fontSize: 14, fontWeight: 500,
              color: '#fff', letterSpacing: '0.06em',
              textAlign: 'center', whiteSpace: 'pre-line', lineHeight: 1.25,
            }}>
              {shutterLabel}
            </div>
          </button>
        </div>

      </div>
    </IPad>
  );
}
