import type { ReactNode } from 'react';

// 全画面ポップアップの共通土台。背景の覆い・白カード・影・余白をここだけで定義する。
// 各画面が同じマークアップを複製すると、片方だけ直して片方が古いまま残る（実際に QR 画面の
// 確認ダイアログでボタンが折り返したままになっていた）。見た目を変えるときはここを触る。
//
// z-index はお詫び(9999)/メンテ(9998)より下。障害系の表示を隠さないための取り決め。
// dataSection はテスト/デバッグ用の識別子。ハーネスの error-overlay 検出と衝突しない値を渡す。
export function ModalShell({
  dataSection,
  children,
}: {
  dataSection: string;
  children: ReactNode;
}) {
  return (
    <div data-section={dataSection} style={{
      position: 'fixed', inset: 0, zIndex: 9000,
      background: 'rgba(6,35,111,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 32,
    }}>
      <div style={{
        background: '#fff', borderRadius: 20, padding: '36px 44px',
        textAlign: 'center', maxWidth: 520,
        fontFamily: 'var(--font-ui)',
        boxShadow: '0 12px 48px rgba(0,0,0,0.25)',
      }}>
        {children}
      </div>
    </div>
  );
}

interface ConfirmDialogProps {
  dataSection: string;
  title: string;
  body: string;
  /** 安全側（継続）のラベル。視線が先に届くよう左に置く */
  cancelLabel: string;
  /** 実行側（TOPへ戻る等）のラベル */
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}

// 「つづける / 実行する」の2択ダイアログ。QRページと途中画面の両方がこれを使う。
export function ConfirmDialog({
  dataSection, title, body, cancelLabel, confirmLabel, onCancel, onConfirm,
}: ConfirmDialogProps) {
  return (
    <ModalShell dataSection={dataSection}>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#06236F', marginBottom: 10 }}>
        {title}
      </div>
      <div style={{ fontSize: 15, lineHeight: 1.8, color: '#333', marginBottom: 22 }}>
        {body}
      </div>
      {/* 2ボタンは均等幅・改行なし。btn-primary の width:100% は inline で上書きする。 */}
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
        <button
          className="btn-primary"
          onClick={onCancel}
          style={{ flex: '1 1 0', width: 'auto', maxWidth: 200, whiteSpace: 'nowrap' }}
        >
          {cancelLabel}
        </button>
        <button
          onClick={onConfirm}
          style={{
            flex: '1 1 0', maxWidth: 200, height: 60, whiteSpace: 'nowrap',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#fff', color: '#06236F',
            border: '1.5px solid rgba(6,35,111,0.45)', borderRadius: 999,
            fontFamily: 'var(--font-ui)', fontSize: 16, fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}
