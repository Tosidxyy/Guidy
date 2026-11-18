import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ChevronUp, Save, ShieldCheck, X } from 'lucide-react';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import { artifactFromPlan, canGenerateSchedule, patchFitsPlanCard, planFromArtifact } from '@/lib/planCard';
import { generateScheduleAction, savePlanCardAction } from '@/lib/planActions';
import { useAutoSaveDraft } from '@/lib/useAutoSaveDraft';
import { useCommitPlan } from '@/lib/useCommitPlan';
import { applyPatch } from '@/shared/engine';
import { usePlanStore } from '@/store/usePlanStore';
import { useChatStore } from '@/store/useChatStore';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConstraintSetBody, ConstraintSetFooter } from './ConstraintSetBody';

/**
 * 方案卡：制定计划与日常修改都只用这一张卡。
 * - AI 给出 constraint_set 或只改任务/约束的 patch 时自动展开，点「确认并生成」直接落库出排程；
 * - 已有计划时显示当前方案，草稿边改边自动保存，已保存计划批量提交差异。
 */
export function PlanCardPanel() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ConstraintSetArtifact | null>(null);
  const [saving, setSaving] = useState(false);
  const state = usePlanStore((s) => s.state);
  const proposal = useChatStore((s) => s.artifact);
  const patch = useChatStore((s) => s.patch);
  const autoSave = useAutoSaveDraft();
  const { commit, isPending } = useCommitPlan(() => {
    useChatStore.setState({ artifact: null, clarifications: [] });
    setOpen(false);
    setDraft(null);
  });

  const unsaved = state.plan.id === null;
  const needsSchedule = canGenerateSchedule(state);
  const enabled = state.constraints.filter((c) => c.enabled).length;

  // AI 给出完整方案时直接展开到这张卡，不再另起确认卡。
  useEffect(() => {
    if (!proposal) return;
    setDraft({ ...proposal, horizon_start: proposal.horizon_start ?? usePlanStore.getState().state.plan.horizon_start });
    setOpen(true);
  }, [proposal]);

  // 只改任务/约束的 AI patch 也交给方案卡：用户在同一张卡里核对、补充后再保存。
  useEffect(() => {
    if (!patch) return;
    const current = usePlanStore.getState().state;
    if (!current.plan.id || !patchFitsPlanCard(patch, current.plan.id)) return;
    setDraft(artifactFromPlan(applyPatch(current, patch.ops).state));
    setOpen(true);
    useChatStore.setState({ patch: null });
  }, [patch]);

  // 有待确认的 AI 方案时，重新打开也回到那张提案，而不是当前计划。
  const openPlan = () => {
    const current = usePlanStore.getState().state;
    const p = useChatStore.getState().artifact;
    setDraft(p ? { ...p, horizon_start: p.horizon_start ?? current.plan.horizon_start } : artifactFromPlan(current));
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setDraft(null);
  };

  // 外部改动（AI patch / 其他入口保存）后，已保存计划的卡片要跟着变，避免用旧快照覆盖云端。
  const syncedVersion = useRef(state.plan.version);
  useEffect(() => {
    if (!open || proposal) { syncedVersion.current = state.plan.version; return; }
    if (syncedVersion.current === state.plan.version) return;
    syncedVersion.current = state.plan.version;
    if (unsaved) return;
    setDraft(artifactFromPlan(usePlanStore.getState().state));
  }, [state.plan.version, open, proposal, unsaved]);

  const toggle = () => {
    if (open) close();
    else openPlan();
  };

  const change = (next: ConstraintSetArtifact) => {
    setDraft(next);
    // 草稿：改动立刻写回本地状态，后台自动保存；已保存计划：留在卡片里，点保存一次性提交。
    if (!proposal && unsaved) {
      const current = usePlanStore.getState().state;
      usePlanStore.getState().applyDraftState(planFromArtifact(current, next));
    }
  };

  // 方案卡保存后再重排：先落任务/约束（草稿首次保存或已保存计划的差异），再生成时间块。
  const saveAndGenerate = async () => {
    if (!draft) return;
    setSaving(true);
    const saved = await savePlanCardAction(draft);
    if (!saved.ok) { setSaving(false); toast.error(saved.reason ?? '保存失败'); return; }
    const r = await generateScheduleAction();
    setSaving(false);
    if (!r.ok) { toast.error(r.reason ?? '生成排程失败'); return; }
    toast.success('已生成排程');
    close();
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

  const statusText = proposal
    ? '待确认'
    : unsaved
      ? autoSave === 'saving' ? '保存中…' : autoSave === 'failed' ? '自动保存失败' : '自动保存'
      : '已保存';

  const hint = proposal
    ? '核对任务与约束；点「确认并生成」后，右侧日历会同步生成排程。'
    : unsaved
      ? '改完不用保存，后台会自动同步到云端；添加任务后点「保存并生成排程」。'
      : '改完点「保存修改」，改动会同步到云端并可撤销。';

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
              <h3 className="font-display text-sm font-semibold text-site-ink">方案卡</h3>
              <p className="mt-0.5 text-xs text-site-ink-soft">{hint}</p>
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
                  {proposal ? (
                    <>
                      <Button variant="outline" size="sm" onClick={() => { useChatStore.setState({ artifact: null, clarifications: [] }); close(); }}>取消</Button>
                      <Button size="sm" className="dawn-gradient text-white" disabled={isPending || draft.task_defs.length === 0} onClick={() => commit(draft)}>
                        {isPending ? '生成中…' : '确认并生成'}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button variant="outline" size="sm" onClick={close}>关闭</Button>
                      {needsSchedule ? (
                        <Button size="sm" className="dawn-gradient text-white" disabled={saving} onClick={() => { void saveAndGenerate(); }}>
                          {saving ? '生成中…' : '保存并生成排程'}
                        </Button>
                      ) : !unsaved ? (
                        <Button size="sm" className="dawn-gradient text-white" disabled={saving} onClick={() => { void saveSaved(); }}>
                          <Save className="mr-1 h-4 w-4" /> {saving ? '保存中…' : '保存修改'}
                        </Button>
                      ) : null}
                    </>
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