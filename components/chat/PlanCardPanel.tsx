import { useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ChevronUp, Save, ShieldCheck } from 'lucide-react';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import { artifactFromPlan, planFromArtifact } from '@/lib/planCard';
import { saveDraftAction } from '@/lib/planActions';
import { usePlanStore } from '@/store/usePlanStore';
import { useUiStore } from '@/store/useUiStore';
import { Button } from '@/components/ui/button';
import { ConstraintSetBody, ConstraintSetFooter } from './ConstraintSetBody';

/**
 * 聊天框上方的方案卡入口：呼出的就是制定计划时那张「核对约束方案」卡片的主体。
 * 草稿状态可编辑并当场保存；已保存的计划只读，编辑仍走约束/任务卡片。
 */
export function PlanCardPanel() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ConstraintSetArtifact | null>(null);
  const [saving, setSaving] = useState(false);
  const state = usePlanStore((s) => s.state);
  const openDrawer = useUiStore((s) => s.openDrawer);
  const unsaved = state.plan.id === null;

  const toggle = () => {
    if (!open) setDraft(artifactFromPlan(usePlanStore.getState().state));
    else setDraft(null);
    setOpen((v) => !v);
  };

  const save = async () => {
    if (!draft) return;
    const store = usePlanStore.getState();
    store.importState(planFromArtifact(store.state, draft));
    setSaving(true);
    const r = await saveDraftAction();
    setSaving(false);
    if (!r.ok) { toast.error(r.reason ?? '保存失败'); return; }
    toast.success('计划已保存到云端');
    setOpen(false);
    setDraft(null);
  };

  return (
    <div className="border-t border-site-line bg-site-bg px-3 py-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-site-ink-soft hover:text-site-ink"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
          <ShieldCheck className="h-3 w-3" />
          <span className="text-site-ink">方案卡</span>
          <span className="tabular">
            约束 {state.constraints.filter((c) => c.enabled).length}/{state.constraints.length} · 任务 {state.task_defs.length}
          </span>
          {unsaved && <span className="rounded bg-site-warning/15 px-1 text-[10px] text-site-warning-text">未保存</span>}
        </button>
        <button type="button" onClick={() => openDrawer('constraints')} className="text-site-brand hover:underline">约束</button>
        <button type="button" onClick={() => openDrawer('tasks')} className="text-site-brand hover:underline">任务</button>
      </div>

      {open && draft && (
        <div className="mt-1.5 max-h-[55vh] overflow-y-auto rounded-lg border border-site-line bg-site-surface p-3">
          <ConstraintSetBody
            draft={draft}
            onChange={setDraft}
            planStart={state.plan.horizon_start}
            readOnly={!unsaved}
            footer={(
              <ConstraintSetFooter>
                <Button variant="outline" size="sm" onClick={() => { setOpen(false); setDraft(null); }}>关闭</Button>
                {unsaved ? (
                  <Button size="sm" className="dawn-gradient text-white" disabled={saving} onClick={() => { void save(); }}>
                    <Save className="mr-1 h-4 w-4" /> {saving ? '保存中…' : '保存计划'}
                  </Button>
                ) : (
                  <span className="text-[11px] text-site-ink-soft">已保存；需要修改请用上方「约束 / 任务」</span>
                )}
              </ConstraintSetFooter>
            )}
          />
        </div>
      )}
    </div>
  );
}