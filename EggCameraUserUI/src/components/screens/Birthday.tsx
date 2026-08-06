import { useState, useEffect, useRef, useCallback } from 'react';
import { IPad } from '../IPad';
import { Page } from '../Page';
import { useLang } from '../../LangContext';

interface BirthdayProps {
  nickname?: string;
  onNext: (days: number, months: number) => void;
  onSkip: () => void;
}

// new Date(year, ...) は year が 0〜99 のとき 1900+year に読み替えられる（JSの仕様）。
// 入力可能年を 0〜9999 に広げたため、必ず setFullYear で年を明示して組み立てる。
function makeDate(year: number, month: number, day: number): Date {
  const d = new Date(0);
  d.setFullYear(year, month - 1, day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function calcDays(year: number, month: number, day: number): number {
  const birth = makeDate(year, month, day);
  const today = new Date();
  return Math.max(0, Math.floor((today.getTime() - birth.getTime()) / 86_400_000));
}

function daysInMonth(year: number, month: number): number {
  // 「翌月の0日」＝当月末日。閏年判定を正しくするため年は setFullYear で渡す。
  const d = new Date(0);
  d.setFullYear(year, month, 0);
  return d.getDate();
}

// 満月齢（暦ベース）。同じ「◯ヶ月」でも実日数はお誕生日によって変わる。
// 例) 2/28生まれ → 1ヶ月未満は 2/28〜4/27(59日間) / 7/1生まれ → 7/1〜8/31(62日間)。
function monthsSinceBirth(year: number, month: number, day: number): number {
  const today = new Date();
  let m = (today.getFullYear() - year) * 12 + (today.getMonth() + 1 - month);
  if (today.getDate() < day) m -= 1;   // 応当日前なら1ヶ月未満
  return Math.max(0, m);
}

// 入力できる年は 0〜9999（スクロールピッカーなので「無制限」は表現できず、
// 実質的な上限＝西暦4桁の全域とする）。1万件になるため PickerCol は仮想化必須。
const YEAR_MIN = 0;
const YEAR_MAX = 9999;
const YEAR_COUNT = YEAR_MAX - YEAR_MIN + 1;

// 誕生日ページを開いたときの初期値
const DEFAULT_YEAR = 2026;
const DEFAULT_MONTH = 4;
const DEFAULT_DAY = 12;

const C = {
  number: 'var(--color-brand-500)',
  caption: 'var(--color-brand-600)',
};

export function Birthday({ nickname, onNext, onSkip }: BirthdayProps) {
  const { lang, T } = useLang();

  const [year, setYear] = useState(DEFAULT_YEAR);
  const [month, setMonth] = useState(DEFAULT_MONTH);
  const [day, setDay] = useState(DEFAULT_DAY);

  const maxDay = daysInMonth(year, month);
  const safeDay = Math.min(day, maxDay);
  // 表示する数字は「お誕生日から撮影日までの日数」そのもの（2026-07-29クライアント確定。
  // 以前の 1000days の考え方＝妊娠期間270日を足す方式は廃止）。
  const days = calcDays(year, month, safeDay);
  // フレームは月齢で選ぶ（暦の月数なので、対象期間はお誕生日によって長さが変わる）。
  const months = monthsSinceBirth(year, month, safeDay);

  const handleYearChange = useCallback((i: number) => setYear(YEAR_MIN + i), []);
  const handleMonthChange = useCallback((i: number) => {
    const m = i + 1;
    setMonth(m);
    setDay(d => Math.min(d, daysInMonth(year, m)));   // 月末日を超える日付を丸める
  }, [year]);
  const handleDayChange = useCallback((i: number) => setDay(i + 1), []);

  const dateLabel = lang === 'ja'
    ? `${year}年 ${month}月 ${safeDay}日 生まれ`
    : `Born on ${year}.${month}.${safeDay}`;

  // 1万件を配列化せず、表示される分だけラベルを組み立てる
  const yearLabel = useCallback(
    (i: number) => lang === 'ja' ? `${YEAR_MIN + i}年` : String(YEAR_MIN + i), [lang]);
  const monthLabel = useCallback(
    (i: number) => lang === 'ja' ? `${i + 1}月` : String(i + 1), [lang]);
  const dayLabel = useCallback(
    (i: number) => lang === 'ja' ? `${i + 1}日` : String(i + 1), [lang]);

  // 年を広げた結果、日数が最大7桁になりうる。120pxのままだと画面幅を超えるので縮める。
  const daysDigits = String(days).length;
  const daysFontSize = daysDigits <= 4 ? 120
    : daysDigits === 5 ? 96
    : daysDigits === 6 ? 78
    : 62;

  return (
    <IPad step={2} totalSteps={5} animKey="bday">
      <Page data-section="birthday-screen" style={{ paddingTop: 50 }}>
        <div className="t-eyebrow" style={{ marginBottom: 50, marginLeft: 12 }}>{T.birthday.step}</div>
        <div className="t-heading" style={{ marginBottom: 30, whiteSpace: 'pre-line' }}>
          {T.birthday.heading}
        </div>

        {/* Date picker */}
        <div data-ui="date-picker" style={{
          border: '1.5px solid var(--color-brand-500)',
          borderRadius: 4, overflow: 'hidden',
          marginBottom: 40, background: 'transparent',
        }}>
          {/* 列の見出し。表記順が国によって違うため、どの列が何かを明示する */}
          <div style={{
            display: 'flex',
            borderBottom: '1px solid var(--color-brand-200)',
            fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600,
            color: 'var(--color-brand-600)', letterSpacing: '0.06em',
          }}>
            {[T.birthday.colYear, T.birthday.colMonth, T.birthday.colDay].map((label, i) => (
              <div key={label} style={{
                flex: 1, textAlign: 'center', padding: '8px 0',
                borderRight: i < 2 ? '1px solid var(--color-brand-200)' : 'none',
              }}>
                {label}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', height: 200 }}>
            <PickerCol
              count={YEAR_COUNT}
              label={yearLabel}
              selectedIndex={year - YEAR_MIN}
              onChange={handleYearChange}
            />
            <PickerCol
              count={12}
              label={monthLabel}
              selectedIndex={month - 1}
              onChange={handleMonthChange}
            />
            <PickerCol
              count={maxDay}
              label={dayLabel}
              selectedIndex={Math.min(safeDay - 1, maxDay - 1)}
              onChange={handleDayChange}
              isLast
            />
          </div>
        </div>

        <div className="t-body" style={{ marginBottom: 10 }}>{T.birthday.body}</div>

        {/* Days since birth（生まれ日ラベル＋日数＋名前をブロックごと動かす） */}
        <div data-ui="birthday-result" style={{
          marginBottom: 10,
          marginTop: 120,
          position: 'relative',
          textAlign: 'center',
        }}>

          {nickname && (
            /* 名前は生年月日ラベルの上。文字設定はラベルと完全に同じ（書体・サイズ・太さ・字間・色） */
            <div style={{
              fontFamily: "'HiraKakuPro-W8', 'Hiragino Kaku Gothic Pro W8', 'ヒラギノ角ゴ Pro W8', 'Noto Sans JP', sans-serif",
              fontSize: 12, fontWeight: 800,
              letterSpacing: '0.18em',
              color: C.number,
              WebkitTextStroke: '0.3px currentColor',
              marginBottom: 20,
            }}>
              {nickname}
            </div>
          )}

          {/* 生年月日ラベル以下（日数・days・since birth）をまとめて15px上へ。
              名前はこの上にあり、位置を変えない */}
          <div style={{
            fontFamily: "'HiraKakuPro-W8', 'Hiragino Kaku Gothic Pro W8', 'ヒラギノ角ゴ Pro W8', 'Noto Sans JP', sans-serif",
            fontSize: 12, fontWeight: 800,
            letterSpacing: '0.18em',
            color: C.number,
            marginTop: -15,
            marginBottom: 20,
            WebkitTextStroke: '0.3px currentColor',
          }}>

            <span style={{
              color: C.number,
              display: 'inline-block',
              position: 'relative',
              top: 5,
            }}>

              {dateLabel}
            </span>
          </div>

          {/* 日数の数字そのものを画面の左右中央に置き、days はその右へ添える。
              数字と days をひとまとまりで中央寄せすると、数字が中心より左へずれる。 */}
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <span key={days} style={{
              position: 'relative',
              fontFamily: "'Futura', 'Century Gothic', sans-serif",
              fontWeight: 700,
              fontSize: daysFontSize,
              lineHeight: 0.82,
              color: C.number,
              letterSpacing: '-0.03em',
              display: 'inline-block',
              animation: 'countPop 0.5s cubic-bezier(0.22, 1, 0.36, 1) both',
            }}>
              {days}
              <span style={{
                position: 'absolute',
                left: '100%', bottom: 0, marginLeft: 10,
                fontFamily: "'Futura', 'Century Gothic', sans-serif",
                fontSize: 30, fontWeight: 700,
                lineHeight: 1,
                letterSpacing: 'normal',
                color: C.number,
              }}>
                days
              </span>
            </span>
          </div>

          {/* 「718 days」の下に改行して置く */}
          <div style={{
            fontFamily: "'Futura', 'Century Gothic', sans-serif",
            fontSize: 30, fontWeight: 700,
            color: C.number,
            marginTop: 6,
          }}>
            since birth
          </div>

        </div>

        {/* 1000days の説明文は廃止（カウントが「お誕生日から撮影日までの日数」になったため） */}
        <div style={{ marginBottom: 'auto' }} />

        <div className="screen-actions" style={{ marginTop: 20 }}>
          <button className="btn-primary" onClick={() => onNext(days, months)}>{T.birthday.next}</button>
          <button className="btn-ghost" onClick={onSkip}>{T.birthday.skip}</button>
        </div>
      </Page>
    </IPad>
  );
}

// ── Scroll-snap picker column ─────────────────────────────────────
const ITEM_H = 40;
const VIEW_H = 200;          // 列の見える高さ（親のheightと一致させる）
const OVERSCAN = 6;          // 前後に余分に描く件数（スクロール時のちらつき防止）

interface PickerColProps {
  count: number;
  label: (index: number) => string;
  selectedIndex: number;
  onChange: (index: number) => void;
  isLast?: boolean;
}

function PickerCol({ count, label, selectedIndex, onChange, isLast }: PickerColProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isProgrammatic = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);

  // 年は1万件あるため全件は描かない。見えている範囲だけ描き、上下はスペーサーで高さを作る。
  // 項目を通常フローに残すことで scroll-snap の効き方を従来と同じに保つ。
  const [scrollTop, setScrollTop] = useState(selectedIndex * ITEM_H);

  const PAD = (VIEW_H - ITEM_H) / 2;
  // count が減ったとき（例: 31日→28日）に scrollTop が古いままだと first が件数を超え、
  // 上スペーサーだけが伸びて総高さが狂う。first を必ず範囲内に丸める。
  // これで first ≤ last が保たれ、上スペーサー+描画分+下スペーサー = count*ITEM_H が常に成立する。
  const first = Math.max(0, Math.min(count - 1, Math.floor(scrollTop / ITEM_H) - OVERSCAN));
  const last = Math.min(count - 1, Math.max(first, Math.ceil((scrollTop + VIEW_H) / ITEM_H) + OVERSCAN));

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = selectedIndex * ITEM_H;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    isProgrammatic.current = true;
    el.scrollTo({ top: selectedIndex * ITEM_H, behavior: 'smooth' });
    setTimeout(() => { isProgrammatic.current = false; }, 350);
  }, [selectedIndex]);

  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
  }, []);

  const handleScroll = useCallback(() => {
    // 描画範囲の更新はrAFで間引く（scrollイベントは高頻度）
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const el = containerRef.current;
        if (el) setScrollTop(el.scrollTop);
      });
    }
    if (isProgrammatic.current) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      const el = containerRef.current;
      if (!el) return;
      const idx = Math.max(0, Math.min(Math.round(el.scrollTop / ITEM_H), count - 1));
      isProgrammatic.current = true;
      el.scrollTo({ top: idx * ITEM_H, behavior: 'smooth' });
      onChange(idx);
      setTimeout(() => { isProgrammatic.current = false; }, 350);
    }, 100);
  }, [count, onChange]);

  return (
    <div style={{
      flex: 1,
      borderRight: isLast ? 'none' : '1px solid var(--color-brand-500)',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', left: 0, right: 0,
        top: '50%', transform: 'translateY(-50%)',
        height: ITEM_H,
        background: 'rgba(81,143,204,0.07)',
        borderTop: '1px solid var(--color-brand-100)',
        borderBottom: '1px solid var(--color-brand-100)',
        pointerEvents: 'none', zIndex: 1,
      }} />
      <div
        ref={containerRef}
        className="picker-scroll"
        onScroll={handleScroll}
        style={{
          height: '100%',
          overflowY: 'scroll',
          scrollSnapType: 'y mandatory',
          paddingTop: PAD,
          paddingBottom: PAD,
        }}
      >
        {first > 0 && <div style={{ height: first * ITEM_H }} />}
        {Array.from({ length: Math.max(0, last - first + 1) }, (_, k) => {
          const i = first + k;
          const isSelected = i === selectedIndex;
          return (
            <div
              key={i}
              onClick={() => {
                const el = containerRef.current;
                if (el) {
                  isProgrammatic.current = true;
                  el.scrollTo({ top: i * ITEM_H, behavior: 'smooth' });
                  setTimeout(() => { isProgrammatic.current = false; }, 350);
                }
                onChange(i);
              }}
              style={{
                height: ITEM_H,
                scrollSnapAlign: 'center',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'var(--font-ui)',
                fontSize: isSelected ? 17 : 15,
                fontWeight: isSelected ? 700 : 400,
                color: isSelected ? 'var(--color-ink-900)' : 'var(--color-gray-300)',
                cursor: 'pointer',
                userSelect: 'none',
                transition: 'color 0.15s, font-weight 0.15s',
                position: 'relative', zIndex: 3,
              }}
            >
              {label(i)}
            </div>
          );
        })}
        {last < count - 1 && <div style={{ height: (count - 1 - last) * ITEM_H }} />}
      </div>
    </div>
  );
}
