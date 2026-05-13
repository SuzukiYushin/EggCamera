import { IPad } from '../IPad';
import { Page } from '../Page';

interface BirthdayProps {
  onNext: (days: number) => void;
  onSkip: () => void;
}

// Mock selected date — picker is visual only in this prototype
const MOCK_YEAR  = 2024;
const MOCK_MONTH = 8;
const MOCK_DAY   = 12;

function calcDays(year: number, month: number, day: number): number {
  const birth = new Date(year, month - 1, day);
  const today = new Date();
  return Math.max(0, Math.floor((today.getTime() - birth.getTime()) / 86_400_000));
}

const MOCK_DAYS = calcDays(MOCK_YEAR, MOCK_MONTH, MOCK_DAY);

export function Birthday({ onNext, onSkip }: BirthdayProps) {
  return (
    <IPad step={2} totalSteps={7} animKey="bday">
      <Page style={{ paddingTop: 28 }}>
        <div className="t-eyebrow" style={{ marginBottom: 12 }}>ステップ 2 / 7</div>
        <div className="t-heading" style={{ marginBottom: 8 }}>
          生年月日を<br />教えてください
        </div>
        <div className="t-body" style={{ marginBottom: 32 }}>日数の計算に使います</div>

        <div style={{
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

        {/* Result card */}
        <div style={{
          marginBottom: 'auto',
          borderRadius: 4,
          overflow: 'hidden',
          border: '1.5px solid var(--color-brand-100)',
          display: 'flex',
          boxShadow: '0 4px 16px rgba(81,143,204,0.12)',
        }}>
          <div style={{
            flex: 1,
            padding: '20px 22px',
            background: 'var(--color-brand-50)',
            borderRight: '1.5px solid var(--color-brand-100)',
          }}>
            <div style={{
              fontFamily: 'Noto Sans JP', fontSize: 11, fontWeight: 500,
              letterSpacing: '0.18em', textTransform: 'uppercase',
              color: 'var(--color-brand-400)', marginBottom: 10,
            }}>BIRTHDAY</div>
            <div style={{
              fontFamily: 'Noto Sans JP', fontWeight: 300, fontSize: 22,
              color: 'var(--color-ink-900)', lineHeight: 1.4,
            }}>
              {MOCK_YEAR}年<br />{MOCK_MONTH}月 {MOCK_DAY}日
            </div>
          </div>
          <div style={{
            width: 120,
            background: 'var(--color-brand-500)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: 2, padding: '16px',
          }}>
            <div style={{
              fontFamily: 'Noto Sans JP', fontSize: 10, fontWeight: 500,
              letterSpacing: '0.14em', color: 'rgba(255,255,255,0.7)',
            }}>生後</div>
            <div style={{
              fontFamily: 'Noto Sans JP', fontWeight: 300, fontSize: 44,
              color: '#fff', lineHeight: 1,
            }}>{MOCK_DAYS}</div>
            <div style={{
              fontFamily: 'Noto Sans JP', fontSize: 13,
              color: 'rgba(255,255,255,0.85)',
            }}>日</div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 36, marginTop: 24 }}>
          <button className="btn-primary" onClick={() => onNext(MOCK_DAYS)}>次へ</button>
          <button className="btn-ghost" onClick={onSkip}>スキップ</button>
        </div>
      </Page>
    </IPad>
  );
}

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
          transition: 'all 0.2s',
        }}>{item}</div>
      ))}
    </div>
  );
}
