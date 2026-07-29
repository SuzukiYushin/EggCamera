import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLang } from '../LangContext';
import { ConfirmDialog } from './Modal';
import { PROTO } from '../api';

// 途中画面（入力〜プレビュー）用の「最初に戻る」ボタン＋確認ダイアログ。
// 客の離脱後に次の客/スタッフが無操作タイムアウトを待たず即リセットするための手動手段。
// 誤タップで進行中の内容を失わないよう必ず確認ダイアログを挟む。
// App 側で画面ボタンより後（JSXの後方=DOM後方）に描画すること：テストハーネスの
// querySelector('button')（=DOM先頭のボタン）がシャッター等を拾う前提を壊さないため。
// data-section はハーネスの error-overlay 検出と衝突しない専用値。
export function QuitFlow({ onRestart }: { onRestart: () => void }) {
  const { T } = useLang();
  const [asking, setAsking] = useState(false);

  // 配置は本番とプロトで分ける（[[camera-fit-cover]] のフルブリードcover化に対応）。
  // 本番: viewport基準の fixed ＋ safe-area。キャンバスは cover(Math.max) で拡大され上端が
  //   crop されうるうえ、非全画面Safariではツールバーが上部を占める。scale されるキャンバス内
  //   (.screen の absolute)だと crop/ツールバーに隠れるので、キャンバス外＝viewport に固定し
  //   safe-area とツールバーの下へ必ず出す（確認ダイアログも同じく fixed で正常動作している）。
  // プロト: iPad枠(768×1024キャンバス)を transform:scale() で縮小表示するので、fixed だと枠外に
  //   浮く。従来どおり .screen へポータルして枠内 absolute に収める。
  const [screenEl, setScreenEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (PROTO) setScreenEl(document.querySelector<HTMLElement>('.screen'));
  }, []);

  const placement = PROTO
    ? { position: 'absolute' as const, top: 18, right: 18 }
    : {
        position: 'fixed' as const,
        top: 'calc(env(safe-area-inset-top, 0px) + 14px)',
        right: 'calc(env(safe-area-inset-right, 0px) + 14px)',
      };

  const quitButton = (
    <button
      data-ui="quit-btn"
      onClick={() => setAsking(true)}
      style={{
        ...placement, zIndex: 100,
        background: 'rgba(255,255,255,0.92)',
        border: '1.5px solid rgba(6,35,111,0.35)',
        borderRadius: 999, padding: '8px 18px',
        fontFamily: 'var(--font-ui)', fontSize: 15, fontWeight: 600,
        color: '#06236F', cursor: 'pointer', whiteSpace: 'nowrap',
        boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
      }}
    >
      {T.quit.button}
    </button>
  );

  return (
    <>
      {PROTO
        ? (screenEl ? createPortal(quitButton, screenEl) : null)
        : quitButton}

      {asking && (
        <ConfirmDialog
          dataSection="quit-confirm"
          title={T.quit.title}
          body={T.quit.body}
          cancelLabel={T.quit.cancel}
          confirmLabel={T.quit.confirm}
          onCancel={() => setAsking(false)}
          onConfirm={onRestart}
        />
      )}
    </>
  );
}
