import * as proto from './protoApi';

// クライアント確認用プロトタイプモード。
// VITE_PROTO=1 でビルドするか、URLに ?proto を付けると有効になり、
// バックエンドAPIをすべてモックに差し替え + 画面選択ナビを表示する。
export const PROTO =
  import.meta.env.VITE_PROTO === '1' ||
  new URLSearchParams(window.location.search).has('proto');

export type SessionStatus = 'idle' | 'capturing' | 'ready' | 'compositing' | 'done' | 'error';

export interface SessionPhoto {
  photoId: string;
  url: string;
}

export interface SessionResult {
  downloadUrl: string;
  qrDataUrl: string;
  expiresAt: number;
}

export interface SessionState {
  id: string;
  status: SessionStatus;
  photos: SessionPhoto[];
  selectedPhotoId?: string;
  nickname?: string;
  days?: number;
  result?: SessionResult;
  error?: string;
  createdAt: number;
  lastTouchedAt: number;
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// fetch のデフォルトタイムアウト。これが無いとネットワーク断時に iOS Safari の
// 既定（~300秒）まで無応答で固まる。撮影・原寸合成など重い処理は個別に延長する。
const DEFAULT_TIMEOUT_MS = 10_000;

// 429(too_many_requests)= サーバのレート制限。混雑で一時的に上限へ達しても、リクエストは
// サーバのビジネスロジックに到達する前に弾かれる＝リトライしても二重セッション作成・二重確定などの
// 副作用は起きない「安全にリトライできる」唯一のケース。少し間隔を空けて後回し再送すれば、
// 実客にお詫び画面を出さず自動回復する。それ以外(4xx/5xx/timeout/network)は副作用や恒久性の
// 懸念があるためリトライしない（従来どおり即エラー化）。
const RATE_LIMIT_MAX_RETRIES = 3;
const RATE_LIMIT_MAX_WAIT_MS = 10_000; // 1回の待機上限（Retry-After が長くても待ちすぎない）
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function request<T>(path: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`/api${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...init,
        // signal は init の後に置き、必ずタイムアウトが効くようにする
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // タイムアウト/ネットワーク断は fetch が throw する。お詫び・診断側で区別できるよう
      // ApiError(0, ...) に正規化する（status=0 = HTTP応答に到達せず落ちた）。
      const name = (err as { name?: string })?.name;
      throw new ApiError(0, name === 'TimeoutError' ? 'timeout' : 'network');
    }
    // レート制限は後回し再送で自動回復を試みる（上限回数まで）。
    if (res.status === 429 && attempt < RATE_LIMIT_MAX_RETRIES) {
      const retryAfterSec = Number(res.headers.get('Retry-After'));
      const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(retryAfterSec * 1000, RATE_LIMIT_MAX_WAIT_MS)   // サーバ指定を尊重（上限クランプ）
        : Math.min(500 * 2 ** attempt, 4_000);                     // 指定が無ければ指数バックオフ 0.5→1→2s
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      let code = `http_${res.status}`;
      try {
        const body = await res.json();
        if (body?.error) code = body.error;
      } catch { /* ignore non-JSON error body */ }
      throw new ApiError(res.status, code);
    }
    return res.json() as Promise<T>;
  }
}

export function createSession(): Promise<{ sessionId: string }> {
  if (PROTO) return proto.createSession();
  return request('/sessions', { method: 'POST' });
}

// スタート押下で iPhone のカメラを先行起動させる（撮影ページの待ち時間軽減）。
// 投げっぱなしで良く、失敗しても画面遷移はそのまま進める。
export function wakeCamera(): Promise<void> {
  if (PROTO) return Promise.resolve();
  return request('/preview/wake', { method: 'POST' }).then(() => {});
}

export function getSession(sessionId: string): Promise<SessionState> {
  if (PROTO) return proto.getSession(sessionId);
  // 1秒間隔でポーリングされるので短め（詰まっても次のpollを止めない）
  return request(`/sessions/${sessionId}`, undefined, 6_000);
}

export function capturePhoto(sessionId: string): Promise<SessionPhoto> {
  if (PROTO) return proto.capturePhoto();
  // 実撮影（iPhoneトリガ＋ファイル待機）が走るので長め。サーバ CAPTURE_TIMEOUT_MS=25s + 余裕。
  return request(`/sessions/${sessionId}/capture`, { method: 'POST' }, 35_000);
}

export interface SelectPhotoParams {
  photoId: string;
  nickname: string;
  days: number;
}

export function selectPhoto(sessionId: string, params: SelectPhotoParams): Promise<{ status: string }> {
  if (PROTO) return proto.selectPhoto();
  return request(`/sessions/${sessionId}/select`, {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

// Active frames managed via the admin panel (/admin). The user UI picks one
// at random; falls back to the bundled frames if this fails or returns [].
export interface FrameInfo {
  id: string;
  name: string;
  url: string;
}

export function getFrames(): Promise<FrameInfo[]> {
  if (PROTO) return proto.getFrames();
  return request('/frames');
}

// 成長するファミちゃん（年齢連動9種＋レア2種）。enabled=false なら getFrames の
// 従来ランダムにフォールバックする。プレビューは days で成長フレームを決定的に選ぶ。
export interface GrowthFrameItem {
  level?: number; minDays?: number; maxDays?: number; number?: number;
  key?: string; label?: string; file: string; url: string;
}
export interface GrowthFramesData {
  enabled: boolean; rareProbability: number;
  growth: GrowthFrameItem[]; rare: GrowthFrameItem[];
}
export function getGrowthFrames(): Promise<GrowthFramesData> {
  if (PROTO) return Promise.resolve({ enabled: false, rareProbability: 0, growth: [], rare: [] });
  return request('/growth-frames');
}

// Crop tuning saved from the admin panel's 写真設定 tab.
export interface CropSettings {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

export function getCropSettings(): Promise<{ crop: CropSettings }> {
  if (PROTO) return proto.getCropSettings();
  return request('/settings');
}

// 運用モード。メンテナンス中はキオスクの操作をロックする。
// serverCompose=true ならサーバ側合成フロー(/compose・/confirm)を使う。
export function getMode(): Promise<{ maintenance: boolean; serverCompose?: boolean; bundle?: string }> {
  if (PROTO) return Promise.resolve({ maintenance: false });
  return request('/mode', undefined, 6_000);
}

// 起動中のバンドル名（例 assets/index-XXXX.js）。開発サーバやプロトでは空になり、
// その場合はビルド更新の判定を行わない。
export const CURRENT_BUNDLE = (() => {
  const src = document.querySelector('script[type="module"][src]')?.getAttribute('src') || '';
  const m = src.match(/assets\/index-[A-Za-z0-9_-]+\.js/);
  return m ? m[0] : '';
})();

// ── サーバ側合成フロー ───────────────────────────────────────────────────
export interface ComposePreview {
  jobId: string;
  fileName: string;
  capturedAt: number;
  thumbDataUrl: string;
}

// プレビュー入場時: サーバで最終画像を原寸合成し、表示用サムネ(dataURL)を受け取る。
export function composePreview(
  sessionId: string,
  params: { photoId: string; nickname: string; daysText: string; days: number; months: number },
): Promise<ComposePreview> {
  // サーバで原寸合成(sharp)が走るので長め
  return request(`/sessions/${sessionId}/compose`, {
    method: 'POST',
    body: JSON.stringify(params),
  }, 25_000);
}

// 決定タップ: 合成ジョブを確定→アップロード worker へ。QR は即返る（アップロード非依存）。
export function confirmComposite(
  sessionId: string,
  jobId: string,
): Promise<{ status: string; jobId: string; fileName: string } & SessionResult> {
  return request(`/sessions/${sessionId}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ jobId }),
  }, 15_000);
}

// ── ローカル障害フロー（系統A/B）─────────────────────────────────────────
export interface JobStatus { status: string; done: boolean; attempts: number; }

// セッション終了時にアップロード完了を確認する。404やエラー時は done:false 扱い。
export function getJobStatus(jobId: string): Promise<JobStatus> {
  return request<JobStatus>(`/jobs/${jobId}/status`, undefined, 6_000)
    .catch(() => ({ status: 'unknown', done: false, attempts: 0 }));
}

export interface Diagnostics {
  server: { ok: boolean };
  internet: { ok: boolean; code?: number; detail?: string };
  pages: { ok: boolean; code?: number; detail?: string };
  r2: { ok: boolean; code?: number; detail?: string };
  networkOk: boolean;
}

// 段階ネットワーク診断（サーバ→外部/Pages/R2）。失敗時は networkOk:false を返す。
export function getDiagnostics(): Promise<Diagnostics> {
  return request<Diagnostics>('/diagnostics', undefined, 12_000)
    .catch(() => ({
      server: { ok: true }, internet: { ok: false }, pages: { ok: false }, r2: { ok: false },
      networkOk: false,
    }));
}

export type IncidentAction = 'recover' | 'maintain-restart' | 'wait-network';
export interface IncidentResult { action: IncidentAction; consecutive?: number; diagnostics?: Diagnostics; }

// 障害報告。系統A: kind='fatal' / 系統B: kind='upload-stuck'。サーバが次アクションを返す。
export function reportIncident(
  body: { kind: 'fatal' | 'upload-stuck'; detail?: string; sessionId?: string | null; jobId?: string | null },
): Promise<IncidentResult> {
  return request<IncidentResult>('/incident', {
    method: 'POST',
    body: JSON.stringify(body),
  }, 15_000).catch(() => ({ action: 'recover' as IncidentAction }));
}

// 系統Aの軽量復旧プローブ: 実撮影なし。カメラ(プレビュー)生存＋サーバ応答を確認し、ok で復旧とみなす。
// 実シャッターを切らないので、カメラ不安定時に撮影連打/多重撮影を誘発しない。
export function probeRecovery(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/recovery/probe', undefined, 8_000)
    .catch(() => ({ ok: false }));
}

// Uploads the client-composited final image (photo + frame + name/days, baked
// in via canvas) as a raw PNG body.
export async function uploadComposite(sessionId: string, blob: Blob): Promise<{ status: string }> {
  if (PROTO) return proto.uploadComposite();
  let res: Response;
  try {
    res = await fetch(`/api/sessions/${sessionId}/composite`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'image/jpeg' },
      body: blob,
      signal: AbortSignal.timeout(35_000), // 最大数十MBの送信＋サーバ保存。長めに確保。
    });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    throw new ApiError(0, name === 'TimeoutError' ? 'timeout' : 'network');
  }
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) code = body.error;
    } catch { /* ignore non-JSON error body */ }
    throw new ApiError(res.status, code);
  }
  return res.json() as Promise<{ status: string }>;
}
