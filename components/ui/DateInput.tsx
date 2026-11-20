import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';

/** 日期输入统一 YYYY-MM-DD，不用浏览器原生 date 外观（避免 11/20/2026 与原生图标）。 */
export function DateInput({ value, onChange, ...props }: { value: string; onChange: (v: string) => void } & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange' | 'type'>) {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  const commit = () => {
    const t = text.trim().replace(/[/.]/g, '-');
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
    if (!m) { setText(value); return; }
    const y = Number(m[1]);
    const mo = Math.min(12, Math.max(1, Number(m[2])));
    const d = Math.min(31, Math.max(1, Number(m[3])));
    const next = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    setText(next);
    onChange(next);
  };
  return (
    <Input
      {...props}
      type="text"
      inputMode="numeric"
      placeholder="YYYY-MM-DD"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur(); } }}
    />
  );
}