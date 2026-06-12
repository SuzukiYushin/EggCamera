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
  frameId?: string;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
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

export function createSession(): Promise<{ sessionId: string }> {
  return request('/sessions', { method: 'POST' });
}

export function getSession(sessionId: string): Promise<SessionState> {
  return request(`/sessions/${sessionId}`);
}

export function capturePhoto(sessionId: string): Promise<SessionPhoto> {
  return request(`/sessions/${sessionId}/capture`, { method: 'POST' });
}

export interface SelectPhotoParams {
  photoId: string;
  frameId: string;
  nickname: string;
  days: number;
}

export function selectPhoto(sessionId: string, params: SelectPhotoParams): Promise<{ status: string }> {
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
  return request('/frames');
}

// Crop tuning saved from the admin panel's 写真設定 tab.
export interface CropSettings {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

export function getCropSettings(): Promise<{ crop: CropSettings }> {
  return request('/settings');
}

// Uploads the client-composited final image (photo + frame + name/days, baked
// in via canvas) as a raw PNG body.
export async function uploadComposite(sessionId: string, blob: Blob): Promise<{ status: string }> {
  const res = await fetch(`/api/sessions/${sessionId}/composite`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: blob,
  });
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
