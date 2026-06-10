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
