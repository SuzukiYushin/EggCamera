import { useState, useEffect, useCallback } from 'react';
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
  onConfirmed: (result: SessionResult) => void;
  onError: () => void;
}

type Phase = 'composing' | 'ready' | 'confirming';

export function FinalPreviewServer({ sessionId, photoId, nickname, days, onConfirmed, onError }: Props) {
  const { T } = useLang();
  const daysText = days > 0 ? T.preview.daysSinceBirth(days) : '';

  const [phase, setPhase] = useState<Phase>('composing');
  const [thumb, setThumb] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const fail = useCallback((where: string, err: unknown) => {
    reportClientError(`${where} failed: ${err}`);
    onError();
  }, [onError]);

  // プレビュー入場時にサーバ合成を依頼し、完成画像のサムネを受け取る。
  useEffect(() => {
    if (!sessionId || !photoId) { onError(); return; }
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
  }, [sessionId, photoId, nickname, daysText, days, onError, fail]);

  const handleConfirm = () => {
    if (phase !== 'ready' || !sessionId || !jobId) return;
    setPhase('confirming');
    confirmComposite(sessionId, jobId)
      .then(({ downloadUrl, qrDataUrl, expiresAt }) => onConfirmed({ downloadUrl, qrDataUrl, expiresAt }))
      .catch(err => fail('confirmComposite', err));
  };

  const busy = phase !== 'ready'; // composing / confirming は無効

  return (
    <IPad step={5} totalSteps={7} animKey="preview">
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
            position: 'relative', aspectRatio: '2/3', height: '90%',
            borderRadius: 4, overflow: 'hidden',
            background: 'rgba(0,0,0,0.05)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            animation: thumb ? 'cameraGlow 4.4s ease-in-out infinite' : 'none',
          }}>
            {thumb
              ? <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              : <div className="t-eyebrow" style={{ opacity: 0.6 }}>{T.preview.saving}</div>}
          </div>
        </div>

        <div style={{ flexShrink: 0, marginTop: 14 }}>
          <button className="btn-primary" onClick={handleConfirm} disabled={busy}>
            {busy ? T.preview.saving : T.preview.save}
          </button>
        </div>
      </Page>
    </IPad>
  );
}
