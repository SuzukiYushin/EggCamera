import { Component } from 'react';
import type { ReactNode } from 'react';
import { reportClientError } from '../clientLog';

// React レンダリング中の例外を拾う最後の砦。window.onerror では拾えない
// 「描画中の例外」で画面が真っ白になるのを防ぐ。ここはツリーが壊れている前提なので
// SPA内遷移はせず、お詫びを出して一定時間後にリロードでトップへ戻す（App内の
// 系統A=メンテ画面+自己診断は、捕捉可能なエラー用。役割を分ける）。
const RELOAD_AFTER_MS = 10_000;

interface Props { children: ReactNode; }
interface State { hasError: boolean; }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };
  private timer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    reportClientError(`render crash: ${error?.message ?? error} ${info?.componentStack ?? ''}`.slice(0, 1500));
    if (this.timer == null) {
      this.timer = setTimeout(() => window.location.reload(), RELOAD_AFTER_MS);
    }
  }

  componentWillUnmount() {
    if (this.timer != null) clearTimeout(this.timer);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div data-section="error-boundary" style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'var(--color-brand-600)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        textAlign: 'center', padding: 48,
      }}>
        <div style={{
          fontFamily: 'var(--font-ui)', fontSize: 26, fontWeight: 700,
          color: '#fff', lineHeight: 2.2, letterSpacing: '0.06em',
        }}>
          ご迷惑をおかけして申し訳ありません。<br />
          お近くのスタッフにお声掛けください
        </div>
      </div>
    );
  }
}
