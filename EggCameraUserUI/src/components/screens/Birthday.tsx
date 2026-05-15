import type { CSSProperties } from 'react';
import { IPad } from '../IPad';
import { Page } from '../Page';
import { useLang } from '../../LangContext';

interface BirthdayProps {
  onNext: (days: number) => void;
  onSkip: () => void;
}

const MOCK_YEAR  = 2024;
const MOCK_MONTH = 8;
const MOCK_DAY   = 12;

function calcDays(year: number, month: number, day: number): number {
  const birth = new Date(year, month - 1, day);
  const today = new Date();
  return Math.max(0, Math.floor((today.getTime() - birth.getTime()) / 86_400_000));
}

const MOCK_DAYS = calcDays(MOCK_YEAR, MOCK_MONTH, MOCK_DAY);

// Sky Blue palette — brand tokens
const C = {
  number:  'var(--color-brand-400)',  // #72A8D9
  caption: 'var(--color-brand-600)',  // #3A77B5
  sparkle: 'var(--color-brand-200)',  // #A3C4E6
  dot:     'var(--color-brand-100)',  // #C3D9EF
};

export function Birthday({ onNext, onSkip }: BirthdayProps) {
  const { lang, T } = useLang();

  const dateLabel = lang === 'ja'
    ? `${MOCK_YEAR}年 ${MOCK_MONTH}月 ${MOCK_DAY}日 生まれ`
    : `Born on ${MOCK_YEAR}.${MOCK_MONTH}.${MOCK_DAY}`;

  return (
    <IPad step={2} totalSteps={7} animKey="bday">
      <Page data-section="birthday-screen" style={{ paddingTop: 28 }}>
        <div className="t-eyebrow" style={{ marginBottom: 12 }}>{T.birthday.step}</div>
        <div className="t-heading" style={{ marginBottom: 8, whiteSpace: 'pre-line' }}>
          {T.birthday.heading}
        </div>
        <div className="t-body" style={{ marginBottom: 28 }}>{T.birthday.body}</div>

        {/* Date picker */}
        <div data-ui="date-picker" style={{
          border: '1.5px solid var(--color-gray-200)',
          borderRadius: 4, overflow: 'hidden',
          marginBottom: 20, background: '#fff',
        }}>
          <div style={{ display: 'flex', height: 200 }}>
            <PickerCol items={['2022年', '2023年', '2024年', '2025年']} selectedIndex={2} />
            <PickerCol items={['6月', '7月', '8月', '9月', '10月']} selectedIndex={2} />
            <PickerCol items={['10日', '11日', '12日', '13日', '14日']} selectedIndex={2} isLast />
          </div>
        </div>

        {/* Days since birth — center minimal, no card/background */}
        <div data-ui="birthday-result" style={{
          marginBottom: 'auto',
          marginTop: 100,
          position: 'relative',
          textAlign: 'center',
        }}>
          {/* "生後" eyebrow */}
          <div style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 12, fontWeight: 500,
            letterSpacing: '0.18em',
            color: C.caption,
            marginBottom: 4,
          }}>
            {T.birthday.daysSince}
          </div>

          {/* Number + unit + decorative scatter */}
          <div style={{
            display: 'inline-flex',
            alignItems: 'baseline',
            gap: 10,
            position: 'relative',
          }}>
            {/* Sparkles (4-point stars) */}
            <Sparkle size={18} color={C.sparkle} style={{ position: 'absolute', top: -22, left: -52 }} />
            <Sparkle size={11} color={C.dot}     style={{ position: 'absolute', top: 22,  left: -64 }} />
            <Sparkle size={14} color={C.sparkle} style={{ position: 'absolute', top: 78,  left: -42 }} />
            <Sparkle size={9}  color={C.dot}     style={{ position: 'absolute', top: -32, left: 28 }} />
            <Sparkle size={13} color={C.sparkle} style={{ position: 'absolute', top: -18, right: -36 }} />
            <Sparkle size={16} color={C.dot}     style={{ position: 'absolute', top: 40,  right: -64 }} />
            <Sparkle size={10} color={C.sparkle} style={{ position: 'absolute', top: 92,  right: -28 }} />
            <Sparkle size={12} color={C.dot}     style={{ position: 'absolute', top: 116, left: 12 }} />
            {/* Dots */}
            <Dot size={7} color={C.number}  style={{ position: 'absolute', top: 8,   left: -82 }} />
            <Dot size={4} color={C.dot}     style={{ position: 'absolute', top: 56,  left: -78 }} />
            <Dot size={5} color={C.sparkle} style={{ position: 'absolute', top: -8,  left: 60 }} />
            <Dot size={6} color={C.dot}     style={{ position: 'absolute', top: 6,   right: -60 }} />
            <Dot size={4} color={C.number}  style={{ position: 'absolute', top: 78,  right: -82 }} />
            <Dot size={5} color={C.sparkle} style={{ position: 'absolute', top: 124, right: -8 }} />
            <Dot size={3} color={C.number}  style={{ position: 'absolute', top: 134, left: -18 }} />
            <Dot size={4} color={C.sparkle} style={{ position: 'absolute', top: -28, right: 18 }} />

            <span style={{
              fontFamily: "'Playfair Display', Georgia, serif",
              fontStyle: 'italic',
              fontWeight: 500,
              fontSize: 138,
              lineHeight: 0.82,
              color: C.number,
              letterSpacing: '-0.03em',
              position: 'relative', zIndex: 1,
            }}>
              {MOCK_DAYS}
            </span>
            <span style={{
              fontFamily: 'var(--font-ui)',
              fontSize: 28,
              fontWeight: 400,
              color: C.number,
              paddingBottom: 12,
              position: 'relative', zIndex: 1,
            }}>
              {T.birthday.days}
            </span>
          </div>

          {/* Date caption */}
          <div style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 13, fontWeight: 400,
            color: C.caption,
            marginTop: 12,
            letterSpacing: '0.04em',
          }}>
            {dateLabel}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 36, marginTop: 20 }}>
          <button className="btn-primary" onClick={() => onNext(MOCK_DAYS)}>{T.birthday.next}</button>
          <button className="btn-ghost" onClick={onSkip}>{T.birthday.skip}</button>
        </div>
      </Page>
    </IPad>
  );
}

// ── Decorative components ────────────────────────────────────────
interface DecoProps {
  size?: number;
  color: string;
  style?: CSSProperties;
}

function Sparkle({ size = 14, color, style }: DecoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" style={style}>
      <path
        d="M10 1 L11.4 8.6 L19 10 L11.4 11.4 L10 19 L8.6 11.4 L1 10 L8.6 8.6 Z"
        fill={color}
      />
    </svg>
  );
}

function Dot({ size = 6, color, style }: DecoProps) {
  return (
    <span style={{
      display: 'inline-block',
      width: size, height: size,
      borderRadius: '50%',
      background: color,
      ...style,
    }} />
  );
}

// ── Picker column ────────────────────────────────────────────────
interface PickerColProps {
  items: string[];
  selectedIndex: number;
  isLast?: boolean;
}

function PickerCol({ items, selectedIndex, isLast }: PickerColProps) {
  return (
    <div style={{
      flex: 1,
      borderRight: isLast ? 'none' : '1px solid var(--color-gray-100)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      position: 'relative',
    }}>
      <div style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(to bottom, rgba(255,255,255,0.95) 0%, transparent 30%, transparent 70%, rgba(255,255,255,0.95) 100%)',
        pointerEvents: 'none', zIndex: 1,
      }} />
      {items.map((item, i) => (
        <div key={item} style={{
          padding: '10px 0',
          fontSize: i === selectedIndex ? 18 : 14,
          color: i === selectedIndex ? 'var(--color-ink-900)' : 'var(--color-ink-300)',
          fontWeight: i === selectedIndex ? 500 : 300,
          fontFamily: 'Noto Sans JP',
        }}>{item}</div>
      ))}
    </div>
  );
}
