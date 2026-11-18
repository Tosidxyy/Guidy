import { useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ChevronUp, Save, ShieldCheck, X } from 'lucide-react';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import { artifactFromPlan, planFromArtifact } from '@/lib/planCard';
import { savePlanCardAction } from '@/lib/planActions';
import { useAutoSaveDraft } from '@/lib/useAutoSaveDraft';
import { usePlanStore } from '@/store/usePlanStore';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConstraintSetBody, ConstraintSetFooter } from './ConstraintSetBody';

/**
 * 聊天框上方的方案卡入口：呼出的就是制定计划时那张「核对约束方案」卡片。
 * 草稿边改边存（后台自动保存）；已保存计划是批量编辑，确认后一次提交。
 */
export function PlanCardPanel() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ConstraintSetArtifact | null>(null);
  const [saving, setSaving] = useState(false);
  const state = usePlanStore((s) => s.state);
  const autoSave = useAutoSaveDraft();
  const unsaved = state.plan.id === null;
  const enabled = state.constraints.filter((c) => c.enabled).length;

  const toggle = () => {
    if (!open) setDraft(artifactFromPlan(usePlanStore.getState().state));
    else setDraft(null);
    setOpen((v) => !v);
  };

  const close = () => { setOpen(false); setDraft(null); };

  const change = (next: ConstraintSetArtifact) => {
    setDraft(next);
    // 草稿：改动立刻写回本地状态，后台自动保存；已保存计划：留在卡片里，点保存一次性提交。
    if (unsaved) {
      const current = usePlanStore.getState().state;
      usePlanStore.getState().applyDraftState(planFromArtifact(current, next));
    }
  };

  const saveSaved = async () => {
    if (!draft) return;
    setSaving(true);
    const r = await savePlanCardAction(draft);
    setSaving(false);
    if (!r.ok) { toast.error(r.reason ?? '保存失败'); return; }
    toast.success('修改已保存');
    close();
  };

  const statusText = unsaved
    ? autoSave === 'saving' ? '保存中…' : autoSave === 'failed' ? '自动保存失败，继续编辑会重试' : '自动保存'
    : '已保存';

  return (
    <div className="relative border-t border-site-line bg-site-bg px-3 py-1.5">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={toggle}
          aria-expanded={open}
          className="h-7 min-w-0 flex-1 justify-start gap-1.5 px-2 text-[11px] font-normal text-site-ink-soft hover:bg-site-surface-2 hover:text-site-ink"
        >
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-site-brand" />
          <span className="font-medium text-site-ink">方案卡</span>
          <span className="tabular">约束 {enabled}/{state.constraints.length} · 任务 {state.task_defs.length}</span>
          <Badge variant="secondary" className="ml-0.5 px-1.5 py-0 text-[10px]">{statusText}</Badge>
          {open ? <ChevronDown className="ml-auto h-3.5 w-3.5" /> : <ChevronUp className="ml-auto h-3.5 w-3.5" />}
        </Button>
      </div>

      {open && draft && (
        <div className="animate-guidy-fade-up absolute bottom-full left-2 right-2 z-40 mb-2 rounded-xl border border-[var(--site-dawn-line)]/40 bg-site-surface p-4 shadow-xl">
          <div className="dawn-gradient mb-3 h-0.5 rounded-full" />
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-display text-sm font-semibold text-site-ink">当前方案</h3>
              <p className="mt-0.5 text-xs text-site-ink-soft">
                {unsaved ? '改完不用保存，后台会自动同步到云端。' : '改完点「保存修改」，改动会同步到云端并可撤销。'}
              </p>
            </div>
            <button type="button" onClick={close} aria-label="收起方案卡" className="rounded p-1 text-site-ink-soft hover:bg-site-surface-2">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="max-h-[50vh] overflow-y-auto pr-1">
            <ConstraintSetBody
              draft={draft}
              onChange={change}
              planStart={state.plan.horizon_start}
              footer={(
                <ConstraintSetFooter>
                  <Button variant="outline" size="sm" onClick={close}>关闭</Button>
                  {!unsaved && (
                    <Button size="sm" className="dawn-gradient text-white" disabled={saving} onClick={() => { void saveSaved(); }}>
                      <Save className="mr-1 h-4 w-4" /> {saving ? '保存中…' : '保存修改'}
                    </Button>
                  )}
                </ConstraintSetFooter>
              )}
            />
          </div>
        </div>
      )}
    </div>
  );
}