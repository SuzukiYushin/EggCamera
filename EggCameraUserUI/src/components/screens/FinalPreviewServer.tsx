import { useState, useEffect, useRef, useCallback } from 'react';
import { IPad } from '../IPad';
import { Page } from '../Page';
import { useLang } from '../../LangContext';
import { composePreview, confirmComposite } from '../../api';
import type { SessionResult } from '../../api';
import { reportClientError } from '../../clientLog';

// サーバ側合成フロー版のプレビュー画面。
// 入場時にサーバへ合成を依頼し、返ってきた完成画像のサムネをそのまま表示する
// （= 真の WYSIWYG）。決定タップでジョブを確定し、QR を受け取って次へ。
// クライアント canvas / toBlob は一切使わないため、iPad Safari のメモリ制限と無縁。
//
// 失敗時は旧フロー(uploadComposite)と同様、握りつぶさずお詫びオーバーレイ(onError→setFatal)
// に倒す（自動リロードでトップへ）。サーバ合成は sharp で堅牢なため通常は起きない。
// なお R2 アップロード失敗は worker が裏で再試行する設計で、ここ(確定時)には影響しない
// （確定時に QR は即発行され、ユーザーは QR を持ち帰れる）。
interface Props {
  sessionId: string | null;
  photoId: string | null;
  nickname: string;
  days: number;
  onConfirmed: (result: SessionResult, jobId: string) => void;
  onError: () => void;
}

type Phase = 'composing' | 'ready' | 'confirming';

// 待ち時間の「動いている」感を出す不確定バー（長さに意味は無い）。
// keyframes は global.css の composeBarSlide。
function WaitBar() {
  return (
    <div style={{ width: 180, height: 6, borderRadius: 3, background: 'rgba(6,35,111,0.12)', overflow: 'hidden' }}>
      <div style={{
        width: '35%', height: '100%', borderRadius: 3,
        background: 'var(--color-brand-500)',
        animation: 'composeBarSlide 1.2s ease-in-out infinite',
      }} />
    </div>
  );
}

// 合成待ちが長引いたら文言を進める（サーバからの進捗イベントは無いので経過時間ベース）
const COMPOSE_SLOW_MS = 4_000;

export function FinalPreviewServer({ sessionId, photoId, nickname, days, onConfirmed, onError }: Props) {
  const { T } = useLang();
  const daysText = days > 0 ? T.preview.daysSinceBirth(days) : '';

  const [phase, setPhase] = useState<Phase>('composing');
  const [thumb, setThumb] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [slowCompose, setSlowCompose] = useState(false);

  // 合成中が COMPOSE_SLOW_MS を超えたら「もうすこしで完成！」へ切替（固まった印象を防ぐ）
  useEffect(() => {
    if (phase !== 'composing') { setSlowCompose(false); return; }
    const t = setTimeout(() => setSlowCompose(true), COMPOSE_SLOW_MS);
    return () => clearTimeout(t);
  }, [phase]);

  // onError は App がインライン関数で渡すため参照が毎レンダー変わる。これを合成 effect の
  // 依存に入れると、無操作カウントダウン（毎秒 setState→App 再レンダー）中に effect が
  // 毎秒再発火して POST /compose を連発する（サーバで job 新規作成＋sharp 子プロセス起動が
  // その回数走る）。ref 経由で最新を呼び、effect は実データのみに依存させる。
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; });

  const fail = useCallback((where: string, err: unknown) => {
    reportClientError(`${where} failed: ${err}`);
    onErrorRef.current();
  }, []);

  // プレビュー入場時にサーバ合成を依頼し、完成画像のサムネを受け取る。
  useEffect(() => {
    if (!sessionId || !photoId) { onErrorRef.current(); return; }
    let cancelled = false;
    setPhase('composing');
    composePreview(sessionId, { photoId, nickname, daysText, days })
      .then(({ jobId, thumbDataUrl }) => {
        if (cancelled) return;
        setJobId(jobId);
        setThumb(thumbDataUrl);
        setPhase('ready');
      })
      .catch(err => { if (!cancelled) fail('composePreview', err); });
    return () => { cancelled = true; };
  }, [sessionId, photoId, nickname, daysText, days, fail]);

  const handleConfirm = () => {
    if (phase !== 'ready' || !sessionId || !jobId) return;
    setPhase('confirming');
    confirmComposite(sessionId, jobId)
      .then(r => onConfirmed({ downloadUrl: r.downloadUrl, qrDataUrl: r.qrDataUrl, expiresAt: r.expiresAt }, r.jobId))
      .catch(err => fail('confirmComposite', err));
  };

  const busy = phase !== 'ready'; // composing / confirming は無効

  return (
    <IPad step={5} totalSteps={5} animKey="preview">
      <Page data-section="preview-screen" style={{ paddingTop: 50, paddingBottom: 28 }}>

        <div data-ui="preview-header" style={{ marginBottom: 0, flexShrink: 0, textAlign: 'center' }}>
          <div className="t-eyebrow" style={{ marginBottom: 40, marginLeft: 0, textAlign: 'left' }}>{T.preview.step}</div>
          <div className="t-heading" style={{ display: 'inline-block', marginBottom: 0 }}>{T.preview.heading}</div>
        </div>

        <div data-ui="photo-composite" style={{
          flex: 1, minHeight: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32,
          position: 'relative',
        }}>
          <div style={{
            position: 'relative', aspectRatio: '2768/6000', height: '90%',
            borderRadius: 4, overflow: 'hidden',
            background: 'rgba(0,0,0,0.05)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            animation: thumb ? 'cameraGlow 4.4s ease-in-out infinite' : 'none',
          }}>
            {thumb
              ? <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              : (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
                  <div className="t-eyebrow" style={{ opacity: 0.8 }}>
                    {slowCompose ? T.preview.almostReady : T.preview.composing}
                  </div>
                  <WaitBar />
                  <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, opacity: 0.5 }}>
                    {T.preview.composingHint}
                  </div>
                </div>
              )}
            {/* 確定(QR発行)中は写真の上に薄いベールで進捗を明示（無反応に見せない） */}
            {phase === 'confirming' && thumb && (
              <div style={{
                position: 'absolute', inset: 0,
                background: 'rgba(255,255,255,0.6)',
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 14,
              }}>
                <div className="t-eyebrow">{T.preview.issuingQr}</div>
                <WaitBar />
              </div>
            )}
          </div>
        </div>

        <div style={{ flexShrink: 0, marginTop: 14 }}>
          <button className="btn-primary" onClick={handleConfirm} disabled={busy}>
            {phase === 'confirming' ? T.preview.issuingQr : busy ? T.preview.saving : T.preview.save}
          </button>
        </div>
      </Page>
    </IPad>
  );
}
