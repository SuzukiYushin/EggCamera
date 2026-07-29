import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'

// ホーム画面追加(standalone)で開かれたかを最初に判定して <html> に印を付ける。
// レイアウトビューポートが画面より短く報告される端末向けの補正(global.css)を効かせるため。
// navigator.standalone は iOS 独自、display-mode はそれ以外の環境向け。両方を見る。
if (
  (window.navigator as Navigator & { standalone?: boolean }).standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches
) {
  document.documentElement.classList.add('standalone');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
