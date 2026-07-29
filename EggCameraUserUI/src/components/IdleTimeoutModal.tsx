import { useLang } from '../LangContext';
import { ModalShell } from './Modal';

// 無操作タイムアウトの確認モーダル（途中画面で客が離脱した場合の TOP 自動復帰前の最終確認）。
// 表示中は画面のどこをタップしても App 側の pointerdown リスナーが発火してタイマーが
// リセットされ、このモーダルは閉じる（「つづける」ボタンは affordance のためで特別処理は不要）。
// 覆い・カードの見た目は ModalShell が持つ（他のポップアップと共通）。
export function IdleTimeoutModal({ secondsLeft }: { secondsLeft: number }) {
  const { T } = useLang();
  return (
    <ModalShell dataSection="idle-timeout">
      <div style={{ fontSize: 24, fontWeight: 700, color: '#06236F', marginBottom: 12 }}>
        {T.idle.title}
      </div>
      <div style={{ fontSize: 16, lineHeight: 1.8, color: '#333', marginBottom: 8 }}>
        {T.idle.body}
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: '#FF3B30', marginBottom: 24 }}>
        {T.idle.countdown(secondsLeft)}
      </div>
      <button className="btn-primary">{T.idle.continue}</button>
    </ModalShell>
  );
}
