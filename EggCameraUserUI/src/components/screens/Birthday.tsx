import { useState, useEffect, useRef, useCallback } from 'react';
import { IPad } from '../IPad';
import { Page } from '../Page';
import { useLang } from '../../LangContext';
import butterflyPink from '../../assets/butterfly_pink.png';
import butterflyBlue from '../../assets/butterfly_blue.png';

interface BirthdayProps {
  nickname?: string;
  onNext: (days: number) => void;
  onSkip: () => void;
}

function calcDays(year: number, month: number, day: number): number {
  const birth = new Date(year, month - 1, day);
  const today = new Date();
  return Math.max(0, Math.floor((today.getTime() - birth.getTime()) / 86_400_000));
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

const YEARS = Array.from({ length: 7 }, (_, i) => 2020 + i); // 2020–2026

const C = {
  number: 'var(--color-brand-500)',
  caption: 'var(--color-brand-600)',
};

export function Birthday({ nickname, onNext, onSkip }: BirthdayProps) {
  const { lang, T } = useLang();

  const [year, setYear] = useState(2024);
  const [month, setMonth] = useState(8);
  const [day, setDay] = useState(12);

  const maxDay = daysInMonth(year, month);
  const safeDay = Math.min(day, maxDay);
  const days = calcDays(year, month, safeDay) + 270;

  const handleYearChange = (i: number) => setYear(YEARS[i]);
  const handleMonthChange = (i: number) => {
    const m = i + 1;
    setMonth(m);
    setDay(d => Math.min(d, daysInMonth(year, m)));
  };
  const handleDayChange = (i: number) => setDay(i + 1);

  const dateLabel = lang === 'ja'
    ? `${year}年 ${month}月 ${safeDay}日 生まれ`
    : `Born on ${year}.${month}.${safeDay}`;

  const yearItems = YEARS.map(y => lang === 'ja' ? `${y}年` : String(y));
  const monthItems = Array.from({ length: 12 }, (_, i) =>
    lang === 'ja' ? `${i + 1}月` : String(i + 1)
  );
  const dayItems = Array.from({ length: maxDay }, (_, i) =>
    lang === 'ja' ? `${i + 1}日` : String(i + 1)
  );

  return (
    <IPad step={2} totalSteps={7} animKey="bday">
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
          <div style={{ display: 'flex', height: 200 }}>
            <PickerCol
              items={yearItems}
              selectedIndex={YEARS.indexOf(year)}
              onChange={handleYearChange}
            />
            <PickerCol
              items={monthItems}
              selectedIndex={month - 1}
              onChange={handleMonthChange}
            />
            <PickerCol
              items={dayItems}
              selectedIndex={Math.min(safeDay - 1, maxDay - 1)}
              onChange={handleDayChange}
              isLast
            />
          </div>
        </div>

        <div className="t-body" style={{ marginBottom: 10 }}>{T.birthday.body}</div>

        {/* Days since birth */}
        <div data-ui="birthday-result" style={{
          marginBottom: 'auto',
          marginTop: 70,
          position: 'relative',
          textAlign: 'center',
        }}>

          <div style={{
            fontFamily: "'HiraKakuPro-W8', 'Hiragino Kaku Gothic Pro W8', 'ヒラギノ角ゴ Pro W8', 'Noto Sans JP', sans-serif",
            fontSize: 12, fontWeight: 800,
            letterSpacing: '0.18em',
            color: C.number,
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

          <img src={butterflyBlue} alt="" aria-hidden="true" style={{
            position: 'absolute',
            left: 'calc(100% + 40px)',
            top: '30%',
            transform: 'translateY(-50%)',
            width: 58, height: 'auto',
          }} />
          </span>
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto 1fr',
            alignItems: 'center',
            columnGap: 10,
          }}>
            {/* Pink butterfly — left of centered number */}
            <img src={butterflyPink} alt="" aria-hidden="true" style={{
              justifySelf: 'end',
              width: 58, height: 'auto',
              alignSelf: 'end',
            }} />

            <span key={days} style={{
              fontFamily: "'Futura', 'Century Gothic', sans-serif",
              fontWeight: 700,
              fontSize: 120,
              lineHeight: 0.82,
              color: C.number,
              letterSpacing: '-0.03em',
              display: 'inline-block',
              animation: 'countPop 0.5s cubic-bezier(0.22, 1, 0.36, 1) both',
              alignSelf: 'end',
            }}>
              {days}
            </span>

            <span style={{
              justifySelf: 'start',
              alignSelf: 'end',
              fontFamily: "'Futura', 'Century Gothic', sans-serif",
              fontSize: 30, fontWeight: 700,
              color: C.number,
            }}>
              days
            </span>
          </div>

          {nickname && (
            <div style={{
              fontFamily: 'var(--font-ui)',
              fontSize: 13, fontWeight: 400,
              color: '#C2DEE8',
              letterSpacing: '0.02em',
              marginTop: 4,
            }}>
              {nickname}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 36, marginTop: 20 }}>
          <button className="btn-primary" onClick={() => onNext(days)}>{T.birthday.next}</button>
          <button className="btn-ghost" onClick={onSkip}>{T.birthday.skip}</button>
        </div>
      </Page>
    </IPad>
  );
}

// ── Scroll-snap picker column ─────────────────────────────────────
const ITEM_H = 40;

interface PickerColProps {
  items: string[];
  selectedIndex: number;
  onChange: (index: number) => void;
  isLast?: boolean;
}

function PickerCol({ items, selectedIndex, onChange, isLast }: PickerColProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isProgrammatic = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const PAD = (200 - ITEM_H) / 2;

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

  const handleScroll = useCallback(() => {
    if (isProgrammatic.current) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      const el = containerRef.current;
      if (!el) return;
      const idx = Math.max(0, Math.min(Math.round(el.scrollTop / ITEM_H), items.length - 1));
      isProgrammatic.current = true;
      el.scrollTo({ top: idx * ITEM_H, behavior: 'smooth' });
      onChange(idx);
      setTimeout(() => { isProgrammatic.current = false; }, 350);
    }, 100);
  }, [items.length, onChange]);

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
        {items.map((item, i) => {
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
              {item}
            </div>
          );
        })}
      </div>
    </div>
  );
}
