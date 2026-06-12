// クライアント確認用プロトタイプのAPIモック。
// バックエンド（Mac mini）なしで全画面のフローを通せるよう、
// api.ts の各関数を PROTO 時にこちらへ差し替える。
import babyImg from './assets/baby_illustrator.png';
import { PROTO_QR } from './assets/protoQr';
import type { SessionPhoto, SessionState, FrameInfo, CropSettings } from './api';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

let shotCount = 0;
let pollCount = 0;

export async function createSession(): Promise<{ sessionId: string }> {
  shotCount = 0;
  pollCount = 0;
  return { sessionId: 'proto-session' };
}

export async function capturePhoto(): Promise<SessionPhoto> {
  await delay(1100); // 実機の撮影テンポを再現
  shotCount += 1;
  return { photoId: `proto-${shotCount}`, url: babyImg };
}

export async function getSession(sessionId: string): Promise<SessionState> {
  await delay(300);
  pollCount += 1;
  const done = pollCount > 3; // 数回ポーリング後に保存完了
  return {
    id: sessionId,
    status: done ? 'done' : 'compositing',
    photos: [],
    createdAt: Date.now(),
    lastTouchedAt: Date.now(),
    result: done ? {
      downloadUrl: 'https://eggcamera.pages.dev/download',
      qrDataUrl: PROTO_QR,
      expiresAt: Date.now() + 24 * 3600_000,
    } : undefined,
  };
}

export async function selectPhoto(): Promise<{ status: string }> {
  return { status: 'ok' };
}

export async function uploadComposite(): Promise<{ status: string }> {
  pollCount = 0;
  await delay(800);
  return { status: 'compositing' };
}

// 空を返すと FinalPreview が同梱の photo_frameA/B/C にフォールバックする
export async function getFrames(): Promise<FrameInfo[]> {
  return [];
}

export async function getCropSettings(): Promise<{ crop: CropSettings }> {
  return { crop: { zoom: 1, offsetX: 0, offsetY: 0 } };
}
