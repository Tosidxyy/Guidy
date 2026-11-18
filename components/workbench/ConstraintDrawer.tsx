import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Pencil, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { CATEGORIES } from '@/shared/constants';
import { ConstraintPayloadSchema } from '@/shared/schemas';
import type { Category, Constraint, ConstraintPayload, Period } from '@/shared/types';
import { usePlanStore } from '@/store/usePlanStore';
import { useUiStore } from '@/store/useUiStore';
import { constraintText } from '@/lib/describe';
import { addConstraintAction, deleteConstraintAction, undoToastAction, updateConstraintAction } from '@/lib/planActions';
import { todayStr } from '@/lib/seed';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const TYPE_LABEL: Record<ConstraintPayload['type'], string> = {
  busy_window: '忙碌窗口（兼职/课程等）',
  active_window: '每日可安排时段',
  daily_cap: '分类每日时长上限',
  mutex: '互斥（不连续/不同天）',
  preferred_period: '偏好时段',
  buffer: '任务间缓冲',
  fixed_block: '固定日程块',
  deadline: '截止日期',
};
const PERIODS: { value: Period; label: string }[] = [
  { value: 'morning', label: '早晨 06–12' },
  { value: 'afternoon', label: '下午 12–18' },
  { value: 'evening', label: '傍晚 18–22' },
  { value: 'night', label: '夜间 22–24' },
];

interface FormState {
  type: ConstraintPayload['type'];
  start: string;
  end: string;
  label: string;
  anchorMode: 'weekday' | 'date';
  weekday: number;
  date: string;
  category: Category;
  maxMinutes: number;
  mutexKind: 'task' | 'category';
  subA: string;
  subB: string;
  mode: 'no_adjacent' | 'no_same_day';
  strength: 'soft' | 'hard';
  prefKind: 'task' | 'category';
  prefTarget: string;
  period: Period;
  bufferMin: number;
  title: string;
}

export function ConstraintDrawer() {
  const open = useUiStore((s) => s.drawer === 'constraints');
  const closeDrawer = useUiStore((s) => s.closeDrawer);
  const state = usePlanStore((s) => s.state);

  const taskKeys = state.task_defs.map((t) => t.key);
  const defaultForm = (): FormState => ({
    type: 'busy_window', start: '18:00', end: '22:00', label: '',
    anchorMode: 'weekday', weekday: 3, date: todayStr(state.plan.timezone),
    category: 'study', maxMinutes: 360,
    mutexKind: taskKeys.length >= 2 ? 'task' : 'category',
    subA: taskKeys[0] ?? 'study', subB: taskKeys[1] ?? 'fitness',
    mode: 'no_adjacent', strength: 'soft',
    prefKind: taskKeys.length ? 'task' : 'category',
    prefTarget: taskKeys[0] ?? 'study', period: 'morning',
    bufferMin: 10, title: '',
  });

  const [form, setForm] = useState<FormState>(defaultForm);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(defaultForm());
      setEditingId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const loadForEdit = (c: Constraint) => {
    const p = c.payload;
    const base = defaultForm();
    const next: FormState = { ...base, type: p.type };
    if ('start' in p) { next.start = p.start; next.end = p.end; }
    if ('label' in p && p.label) next.label = p.label;
    if ('weekday' in p && p.weekday !== undefined) { next.anchorMode = 'weekday'; next.weekday = p.weekday; }
    if ('date' in p && p.date) { next.anchorMode = 'date'; next.date = p.date; }
    if (p.type === 'daily_cap') { next.category = p.category; next.maxMinutes = p.max_minutes; }
    if (p.type === 'mutex') {
      next.mutexKind = p.subjects.kind; next.subA = p.subjects.values[0]; next.subB = p.subjects.values[1];
      next.mode = p.mode; next.strength = p.strength;
    }
    if (p.type === 'preferred_period') {
      next.prefKind = p.task_key ? 'task' : 'category';
      next.prefTarget = p.task_key ?? p.category ?? 'study';
      next.period = p.period;
    }
    if (p.type === 'buffer') next.bufferMin = p.minutes;
    if (p.type === 'fixed_block') { next.title = p.title; next.category = p.category; }
    if (p.type === 'deadline') { next.date = p.date; next.label = p.label; }
    setForm(next);
    setEditingId(c.id);
  };

  const buildPayload = (): ConstraintPayload | null => {
    const anchor = form.anchorMode === 'weekday' ? { weekday: form.weekday } : { date: form.date };
    let payload: unknown;
    switch (form.type) {
      case 'busy_window':
        payload = { type: 'busy_window', ...anchor, start: form.start, end: form.end, ...(form.label.trim() ? { label: form.label.trim() } : {}) };
        break;
      case 'active_window':
        payload = { type: 'active_window', start: form.start, end: form.end };
        break;
      case 'daily_cap':
        payload = { type: 'daily_cap', category: form.category, max_minutes: form.maxMinutes };
        break;
      case 'mutex':
        payload = { type: 'mutex', subjects: { kind: form.mutexKind, values: [form.subA, form.subB] }, mode: form.mode, strength: form.strength };
        break;
      case 'preferred_period':
        payload = { type: 'preferred_period', period: form.period, strength: 'soft', ...(form.prefKind === 'task' ? { task_key: form.prefTarget } : { category: form.prefTarget as Category }) };
        break;
      case 'buffer':
        payload = { type: 'buffer', minutes: form.bufferMin };
        break;
      case 'fixed_block':
        payload = { type: 'fixed_block', title: form.title.trim(), category: form.category, ...anchor, start: form.start, end: form.end };
        break;
      case 'deadline':
        payload = { type: 'deadline', date: form.date, label: form.label.trim() };
        break;
    }
    const parsed = ConstraintPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? '约束格式不正确');
      return null;
    }
    return parsed.data;
  };

  const submit = () => {
    const payload = buildPayload();
    if (!payload) return;
    if (editingId) {
      void updateConstraintAction(editingId, { payload }).then((r) => {
        if (r.ok) toast.success('约束已更新，已按新约束重排', { action: undoToastAction(r.planId) });
      });
    } else {
      void addConstraintAction(payload).then((r) => {
        if (r.ok) toast.success('约束已添加，已按新约束重排', { action: undoToastAction(r.planId) });
      });
    }
    setForm(defaultForm());
    setEditingId(null);
  };

  const subjectOptions = form.mutexKind === 'task'
    ? taskKeys.map((k) => ({ value: k, label: state.task_defs.find((t) => t.key === k)?.title ?? k }))
    : CATEGORIES.map((c) => ({ value: c.key, label: c.label }));
  const prefOptions = form.prefKind === 'task'
    ? taskKeys.map((k) => ({ value: k, label: state.task_defs.find((t) => t.key === k)?.title ?? k }))
    : CATEGORIES.map((c) => ({ value: c.key, label: c.label }));

  const timeFields = (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="c-start">开始</Label>
        <Input id="c-start" type="time" value={form.start} onChange={(e) => set('start', e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="c-end">结束</Label>
        <Input id="c-end" type="time" value={form.end} onChange={(e) => set('end', e.target.value)} />
      </div>
    </div>
  );

  const anchorFields = (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="c-anchor-mode">重复方式</Label>
        <NativeSelect id="c-anchor-mode" value={form.anchorMode} onChange={(e) => set('anchorMode', e.target.value as 'weekday' | 'date')}>
          <NativeSelectOption value="weekday">每周重复</NativeSelectOption>
          <NativeSelectOption value="date">指定日期</NativeSelectOption>
        </NativeSelect>
      </div>
      {form.anchorMode === 'weekday' ? (
        <div className="space-y-1.5">
          <Label htmlFor="c-weekday">星期</Label>
          <NativeSelect id="c-weekday" value={String(form.weekday)} onChange={(e) => set('weekday', Number(e.target.value))}>
            {WEEKDAYS.map((w, i) => <NativeSelectOption key={w} value={String(i)}>{w}</NativeSelectOption>)}
          </NativeSelect>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="c-date">日期</Label>
          <Input id="c-date" type="date" value={form.date} onChange={(e) => set('date', e.target.value)} />
        </div>
      )}
    </div>
  );

  const categoryField = (
    <div className="space-y-1.5">
      <Label htmlFor="c-category">分类</Label>
      <NativeSelect id="c-category" value={form.category} onChange={(e) => set('category', e.target.value as Category)}>
        {CATEGORIES.map((c) => <NativeSelectOption key={c.key} value={c.key}>{c.label}</NativeSelectOption>)}
      </NativeSelect>
    </div>
  );

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) closeDrawer(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-md">
        <SheetHeader className="border-b border-site-line px-5 py-4">
          <SheetTitle className="font-display flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-site-brand" /> 约束条件</SheetTitle>
          <SheetDescription>约束决定引擎如何为你排程。修改后会立即按新约束重排，可撤销。</SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 px-5 py-4">
          <ul className="space-y-1.5">
            {state.constraints.map((c) => (
              <li key={c.id} className="flex items-center gap-2 rounded-lg border border-site-line bg-site-surface px-2.5 py-2">
                <Switch checked={c.enabled} onCheckedChange={(v) => { void updateConstraintAction(c.id, { enabled: v }); }} className="scale-90" aria-label="启用约束" />
                <span className="min-w-0 flex-1 text-xs leading-snug text-site-ink">{constraintText(c.payload, (k) => state.task_defs.find((t) => t.key === k)?.title ?? k)}</span>
                <button type="button" aria-label="编辑约束" className="rounded p-1 text-site-ink-soft hover:text-site-brand" onClick={() => loadForEdit(c)}>
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button" aria-label="删除约束" className="rounded p-1 text-site-ink-soft hover:text-site-danger"
                  onClick={() => {
                    void deleteConstraintAction(c.id).then((r) => {
                      if (!r.ok) return;
                      if (editingId === c.id) { setEditingId(null); setForm(defaultForm()); }
                      toast('已删除约束', { action: undoToastAction(r.planId) });
                    });
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
            {state.constraints.length === 0 && <li className="rounded-lg border border-dashed border-site-line p-3 text-center text-xs text-site-ink-soft">暂无约束</li>}
          </ul>

          <Separator />

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-site-ink">{editingId ? '编辑约束' : '新增约束'}</h3>
              {editingId && (
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => { setEditingId(null); setForm(defaultForm()); }}>
                  <X className="mr-1 h-3.5 w-3.5" /> 取消编辑
                </Button>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="c-type">约束类型</Label>
              <NativeSelect
                id="c-type" value={form.type}
                onChange={(e) => {
                  const type = e.target.value as ConstraintPayload['type'];
                  setForm((f) => ({
                    ...f, type,
                    subA: f.mutexKind === 'task' ? (taskKeys[0] ?? 'study') : 'study',
                    subB: f.mutexKind === 'task' ? (taskKeys[1] ?? 'fitness') : 'fitness',
                  }));
                }}
              >
                {(Object.keys(TYPE_LABEL) as ConstraintPayload['type'][]).map((t) => (
                  <NativeSelectOption key={t} value={t}>{TYPE_LABEL[t]}</NativeSelectOption>
                ))}
              </NativeSelect>
            </div>

            {(form.type === 'busy_window' || form.type === 'fixed_block') && anchorFields}
            {(form.type === 'busy_window' || form.type === 'active_window' || form.type === 'fixed_block') && timeFields}

            {form.type === 'busy_window' && (
              <div className="space-y-1.5">
                <Label htmlFor="c-label">备注（可选）</Label>
                <Input id="c-label" value={form.label} maxLength={30} placeholder="例如：兼职" onChange={(e) => set('label', e.target.value)} />
              </div>
            )}

            {form.type === 'fixed_block' && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="c-fixed-title">日程名称</Label>
                  <Input id="c-fixed-title" value={form.title} maxLength={60} placeholder="例如：组会" onChange={(e) => set('title', e.target.value)} />
                </div>
                {categoryField}
              </>
            )}

            {form.type === 'daily_cap' && (
              <>
                {categoryField}
                <div className="space-y-1.5">
                  <Label htmlFor="c-cap">每日上限（分钟，30–960）</Label>
                  <Input id="c-cap" type="number" min={30} max={960} step={30} value={form.maxMinutes} onChange={(e) => set('maxMinutes', Number(e.target.value))} />
                </div>
              </>
            )}

            {form.type === 'mutex' && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="c-mutex-kind">互斥主体</Label>
                  <NativeSelect
                    id="c-mutex-kind" value={form.mutexKind}
                    onChange={(e) => {
                      const kind = e.target.value as 'task' | 'category';
                      setForm((f) => ({
                        ...f, mutexKind: kind,
                        subA: kind === 'task' ? (taskKeys[0] ?? '') : 'study',
                        subB: kind === 'task' ? (taskKeys[1] ?? '') : 'fitness',
                      }));
                    }}
                  >
                    <NativeSelectOption value="task">具体任务</NativeSelectOption>
                    <NativeSelectOption value="category">分类</NativeSelectOption>
                  </NativeSelect>
                </div>
                {form.mutexKind === 'task' && taskKeys.length < 2 && (
                  <p className="text-xs text-site-warning-text">需要至少 2 个任务定义才能设置任务互斥，请先在「任务定义」中添加。</p>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="c-sub-a">主体 A</Label>
                    <NativeSelect id="c-sub-a" value={form.subA} onChange={(e) => set('subA', e.target.value)}>
                      {subjectOptions.map((o) => <NativeSelectOption key={o.value} value={o.value}>{o.label}</NativeSelectOption>)}
                    </NativeSelect>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="c-sub-b">主体 B</Label>
                    <NativeSelect id="c-sub-b" value={form.subB} onChange={(e) => set('subB', e.target.value)}>
                      {subjectOptions.map((o) => <NativeSelectOption key={o.value} value={o.value}>{o.label}</NativeSelectOption>)}
                    </NativeSelect>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="c-mode">互斥方式</Label>
                    <NativeSelect id="c-mode" value={form.mode} onChange={(e) => set('mode', e.target.value as FormState['mode'])}>
                      <NativeSelectOption value="no_adjacent">不连续安排</NativeSelectOption>
                      <NativeSelectOption value="no_same_day">不在同一天</NativeSelectOption>
                    </NativeSelect>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="c-strength">强度</Label>
                    <NativeSelect id="c-strength" value={form.strength} onChange={(e) => set('strength', e.target.value as FormState['strength'])}>
                      <NativeSelectOption value="soft">软性（建议）</NativeSelectOption>
                      <NativeSelectOption value="hard">硬性（必须）</NativeSelectOption>
                    </NativeSelect>
                  </div>
                </div>
              </>
            )}

            {form.type === 'preferred_period' && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="c-pref-kind">应用到</Label>
                    <NativeSelect
                      id="c-pref-kind" value={form.prefKind}
                      onChange={(e) => {
                        const kind = e.target.value as 'task' | 'category';
                        setForm((f) => ({ ...f, prefKind: kind, prefTarget: kind === 'task' ? (taskKeys[0] ?? '') : 'study' }));
                      }}
                    >
                      <NativeSelectOption value="task">具体任务</NativeSelectOption>
                      <NativeSelectOption value="category">分类</NativeSelectOption>
                    </NativeSelect>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="c-pref-target">对象</Label>
                    <NativeSelect id="c-pref-target" value={form.prefTarget} onChange={(e) => set('prefTarget', e.target.value)}>
                      {prefOptions.map((o) => <NativeSelectOption key={o.value} value={o.value}>{o.label}</NativeSelectOption>)}
                    </NativeSelect>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="c-period">偏好时段</Label>
                  <NativeSelect id="c-period" value={form.period} onChange={(e) => set('period', e.target.value as Period)}>
                    {PERIODS.map((p) => <NativeSelectOption key={p.value} value={p.value}>{p.label}</NativeSelectOption>)}
                  </NativeSelect>
                </div>
              </>
            )}

            {form.type === 'buffer' && (
              <div className="space-y-1.5">
                <Label htmlFor="c-buffer">缓冲分钟数（0–120）</Label>
                <Input id="c-buffer" type="number" min={0} max={120} step={5} value={form.bufferMin} onChange={(e) => set('bufferMin', Number(e.target.value))} />
              </div>
            )}

            {form.type === 'deadline' && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="c-deadline-date">日期</Label>
                  <Input id="c-deadline-date" type="date" value={form.date} onChange={(e) => set('date', e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="c-deadline-label">名称</Label>
                  <Input id="c-deadline-label" value={form.label} maxLength={30} placeholder="例如：考研初试" onChange={(e) => set('label', e.target.value)} />
                </div>
              </>
            )}

            <Button className="w-full" onClick={submit}>
              <Plus className="mr-1.5 h-4 w-4" /> {editingId ? '保存修改' : '添加约束'}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}