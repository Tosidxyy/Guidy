import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';

/** 24 小时制时间输入：不用浏览器原生 time 外观（避免出现 AM/PM 与原生图标）。 */
export function TimeInput({ value, onChange, ...props }: { value: string; onChange: (v: string) => void } & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange' | 'type'>) {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  const commit = () => {
    const m = /^(\d{1,2})[:：]?(\d{2})?$/.exec(text.trim());
    if (!m) { setText(value); return; }
    const h = Math.min(23, Math.max(0, Number(m[1])));
    const min = Math.min(59, Math.max(0, Number(m[2] ?? '0')));
    const next = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    setText(next);
    onChange(next);
  };
  return (
    <Input
      {...props}
      type="text"
      inputMode="numeric"
      placeholder="HH:mm"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur(); } }}
    />
  );
}