import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ChevronUp, ShieldCheck } from 'lucide-react';
import type { ConstraintSetArtifact } from '@/shared/schemas';
import { artifactFromPlan, canGenerateSchedule, patchFitsPlanCard, planFromArtifact, stagePatchOnDraft } from '@/lib/planCard';
import { generateScheduleAction, savePlanCardAction } from '@/lib/planActions';
import { useApplyPatch } from '@/lib/useApplyPatch';
import { useAutoSaveDraft } from '@/lib/useAutoSaveDraft';
import { useCommitPlan } from '@/lib/useCommitPlan';
import { appliedPatches } from '@/lib/appliedPatches';
import { constraintText, patchOpText } from '@/lib/describe';
import { solveArtifact } from '@/lib/preview';
import { groupSchedules, isSchedule } from '@/lib/confirmDraft';
import { cn } from '@/lib/utils';
import { usePlanStore } from '@/store/usePlanStore';
import { useChatStore } from '@/store/useChatStore';
import { useSharedCalendar } from '@/store/useSharedCalendar';
import { applySharedOps } from '@/lib/sharedBlocks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConstraintSetBody, ConstraintSetFooter } from './ConstraintSetBody';

// 忙时/固定日程物化在共享日历而非计划任务里：方案卡必须可见可删，否则用户找不到「上班」这类块。
function SharedBusySection() {
  const busy = useSharedCalendar((s) => s.busyBlocks);
  const tz = usePlanStore((s) => s.state.plan.timezone) || 'Asia/Shanghai';
  if (!busy.length) return null;
  const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short', timeZone: tz });
  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
  const sorted = [...busy].sort((a, b) => a.start_utc.localeCompare(b.start_utc));
  return (
    <section className="mt-3 border-t border-site-line pt-2">
      <h4 className="text-xs font-semibold text-site-ink">固定日程 / 公共忙时（{sorted.length}）</h4>
      <p className="mt-0.5 text-[11px] text-site-ink-soft">来自共享日历（如「上班」），参与排程避让；可在此删除（例如某天请假）。</p>
      <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto">
        {sorted.slice(0, 60).map((b) => (
          <li key={b.id} className="flex items-center justify-between gap-2 rounded border border-site-line bg-site-surface-2 px-2 py-1 text-[11px] text-site-ink">
            <span className="truncate">{b.title} · {fmtDay(b.start_utc)} {fmtTime(b.start_utc)}–{fmtTime(b.end_utc)}</span>
            <Button
              variant="ghost" size="sm" className="h-6 px-1.5 text-[11px] text-site-danger"
              onClick={() => { void applySharedOps([{ op: 'remove_block', id: b.id }]).then((r) => { if (!r.ok) toast.error(r.reason ?? '删除失败'); }); }}
            >
              删除
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 方案卡：制定计划与日常修改都只用这一张卡。
 * - AI 给出 constraint_set 或只改任务/约束的 patch 时自动展开，点「确认并生成」直接落库出排程；
 * - 已有计划时显示当前方案，草稿边改边自动保存，已保存计划批量提交差异。
 */
export function PlanCardPanel() {
  const [open, setOpen] = useState(false);
  const [attention, setAttention] = useState(false);
  const [draft, setDraft] = useState<ConstraintSetArtifact | null>(null);
  const [saving, setSaving] = useState(false);
  const state = usePlanStore((s) => s.state);
  const proposal = useChatStore((s) => s.artifact);
  const serverPreview = useChatStore((s) => s.artifactPreview);
  const patch = useChatStore((s) => s.patch);
  const conversationId = useChatStore((s) => s.conversationId);
  const autoSave = useAutoSaveDraft();
  const { apply: applyPatchOps, isPending: patchPending } = useApplyPatch();
  const { commit, isPending } = useCommitPlan(() => {
    useChatStore.setState({ artifact: null, clarifications: [] });
    setOpen(false);
    setDraft(null);
  });

  const unsaved = state.plan.id === null;
  const needsSchedule = canGenerateSchedule(state);

  // 入口计数与展开内容共用同一数据源：编辑草稿 > AI 提案 > 当前计划，杜绝两者不一致。
  const proposalDraft = proposal ? { ...proposal, horizon_start: proposal.horizon_start ?? state.plan.horizon_start } : null;
  const viewed = useMemo(
    () => draft ?? proposalDraft ?? artifactFromPlan(state),
    [draft, proposalDraft, state],
  );
  const taskCount = viewed.task_defs.length;
  const constraintList = viewed.constraints;
  const scheduleCount = groupSchedules(viewed).length;
  const ruleCount = constraintList.filter((c) => !isSchedule(c)).length;
  const planTitle = viewed.plan_title;

  // 可行性以服务端 pre-solve 为权威；恢复旧对话没有服务端预览时用同一引擎本地预估，并明确标注。
  const localPreview = useMemo(() => {
    if (!proposal || serverPreview) return null;
    const { output } = solveArtifact(draft ?? proposalDraft ?? proposal, { horizon_start: state.plan.horizon_start, timezone: state.plan.timezone }, state.blocks);
    return { feasibility: output.feasibility, unplaced: output.unplaced, violations: output.violations, compromises: output.compromises, _local: true };
  }, [proposal, serverPreview, draft, proposalDraft, state]);
  const preview: any = (proposal ? (serverPreview ?? localPreview) : null) as any;
  const num = (v: unknown) => Number(v) || 0;
  const unplacedList: any[] = preview?.unplaced ?? [];
  const violationsList: any[] = preview?.violations ?? [];
  const compromisesList: any[] = preview?.compromises ?? [];
  const targetMin = unplacedList.reduce((m, u) => m + num(u.target_minutes), 0);
  const placedMin = unplacedList.reduce((m, u) => m + num(u.placed_minutes), 0);
  const missingMin = unplacedList.reduce((m, u) => m + num(u.missing_minutes), 0);
  const feasibilityText: Record<string, string> = { FEASIBLE: '全部可排', PARTIAL: '部分可行', INFEASIBLE: '不可行', UNKNOWN: '待确认' };
  const feasibilityCls: Record<string, string> = {
    FEASIBLE: 'bg-site-success/15 text-site-success',
    PARTIAL: 'bg-site-warning/15 text-site-warning',
    INFEASIBLE: 'bg-site-danger/15 text-site-danger',
    UNKNOWN: 'bg-site-ink/10 text-site-ink-soft',
  };
  const constraintForViolation = (id?: string) => {
    const m = /^(?:pre|ai)-(\d+)$/.exec(id ?? '');
    if (!m) return null;
    const c = viewed.constraints[Number(m[1])];
    return c ? constraintText(c, (key) => viewed.task_defs.find((t) => t.key === key)?.title ?? key) : null;
  };

  // AI 给出完整方案：计数更新但不自动展开；入口闪烁提示用户手动呼出确认。
  useEffect(() => {
    if (!proposal) return;
    setAttention(true);
  }, [proposal]);

  // 只改任务/约束的 AI patch：叠加在用户未保存的编辑草稿上，计数与内容同步更新，闪烁提示手动核对。
  useEffect(() => {
    if (!patch) return;
    const current = usePlanStore.getState().state;
    if (!current.plan.id || !patchFitsPlanCard(patch, current.plan.id)) return;
    setDraft(stagePatchOnDraft(current, draft, patch));
    setAttention(true);
    useChatStore.setState({ patch: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patch]);

  // 对话/计划切换后清空上一对话的编辑草稿：方案卡随对话唯一，不留残留数据。
  useEffect(() => {
    setDraft(null);
    setAttention(false);
  }, [conversationId, state.plan.id]);

  // 含块移动/重排的 patch 也留在同一张卡里应用：卡片下方给出调整清单，不再单独弹确认卡。
  const foreignPatch = patch && state.plan.id && !patchFitsPlanCard(patch, state.plan.id) ? patch : null;
  const patchAlreadyApplied = !!patch && !!conversationId && appliedPatches.isApplied(conversationId, patch);
  useEffect(() => {
    if (!foreignPatch) return;
    if (patchAlreadyApplied) { useChatStore.setState({ patch: null }); return; }
    setAttention(true);
  }, [foreignPatch, patchAlreadyApplied]);

  // 打开时保留编辑草稿（AI patch 的结果暂存在草稿里，清掉会看到旧/空内容）。
  const openPlan = () => {
    setAttention(false);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
  };

  const toggle = () => {
    if (open) close();
    else openPlan();
  };

  const change = (next: ConstraintSetArtifact) => {
    setDraft(next);
    // 用户改动后服务端预览已过期，清掉避免误导；提交成功与否仍以服务端为准。
    if (proposal) useChatStore.setState({ artifactPreview: null });
    // 草稿：改动立刻写回本地状态，后台自动保存；已保存计划：留在卡片里，点保存一次性提交。
    if (!proposal && unsaved) {
      const current = usePlanStore.getState().state;
      usePlanStore.getState().applyDraftState(planFromArtifact(current, next));
    }
  };

  // 方案卡保存后再重排：先落任务/约束（草稿首次保存或已保存计划的差异），再生成时间块。
  const saveAndGenerate = async () => {
    setSaving(true);
    const saved = await savePlanCardAction(viewed);
    if (!saved.ok) { setSaving(false); toast.error(saved.reason ?? '保存失败'); return; }
    const r = await generateScheduleAction();
    setSaving(false);
    if (!r.ok) { toast.error(r.reason ?? '生成排程失败'); return; }
    toast.success('已保存并生成排程');
    setAttention(false);
    close();
  };

  // 应用 AI 排程调整前先落卡片里未保存的编辑（如删除任务），否则调整按服务端旧状态应用会复活它们。
  const applyForeign = async () => {
    if (!foreignPatch) return;
    if (draft) {
      setSaving(true);
      const saved = await savePlanCardAction(viewed);
      setSaving(false);
      if (!saved.ok) { toast.error(saved.reason ?? '保存卡片修改失败'); return; }
    }
    setDraft(null);
    setAttention(false);
    void applyPatchOps(foreignPatch);
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
    <div className="px-2 pb-2 pt-1">
      <div className={cn('overflow-hidden rounded-xl border bg-site-surface shadow-sm transition-colors', attention && !open ? 'border-site-flow/40' : 'border-site-ink/12')}>
      <div className="flex items-center">
        <Button
          variant="ghost"
          size="sm"
          onClick={toggle}
          aria-expanded={open}
          className="relative h-8 min-w-0 flex-1 justify-start gap-1.5 rounded-none px-2.5 text-[11px] font-normal text-site-ink-soft hover:bg-site-surface-2 hover:text-site-ink"
        >
          {attention && !open && <span aria-hidden="true" className="guidy-card-pulse pointer-events-none absolute inset-0" />}
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-site-ink" />
          <span className="shrink-0 font-medium text-site-ink">方案卡</span>
          <span className="min-w-0 truncate text-site-ink">{planTitle}</span>
          <span className="tabular shrink-0">任务 {taskCount + scheduleCount} · 约束 {ruleCount}</span>
          <Badge variant="secondary" className="ml-0.5 shrink-0 px-1.5 py-0 text-[10px]">{statusText}</Badge>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {attention && !open && <span className="text-[10px] font-medium text-site-flow">请点击确认</span>}
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </span>
        </Button>
      </div>

      {(
        <div className={cn('grid transition-[grid-template-rows,margin-top] duration-300 ease-out', open ? 'mt-0 grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
          <div className="overflow-hidden">
            <div className="border-t border-site-line">
          <div className="flex items-start justify-between gap-3 px-3.5 pt-3">
            <div>
              <h3 className="font-display text-sm font-semibold text-site-ink">{viewed.plan_title || '方案卡'}</h3>
              <p className="mt-0.5 text-xs text-site-ink-soft">{hint}</p>
            </div>
          </div>

          {foreignPatch && !patchAlreadyApplied && (
          <section className="mx-3.5 mt-3 rounded-lg border border-site-line bg-site-bg p-2.5">
            <p className="text-xs font-semibold text-site-ink">排程调整 · {foreignPatch.summary}</p>
            <ul className="mt-1.5 max-h-28 space-y-1 overflow-y-auto">
              {foreignPatch.ops.map((op, i) => (
                <li key={i} className="rounded border border-site-line bg-site-surface px-2 py-1 text-[11px] leading-snug text-site-ink">
                  {patchOpText(op, (key) => state.task_defs.find((t) => t.key === key)?.title ?? key, state.plan.timezone)}
                </li>
              ))}
            </ul>
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => useChatStore.setState({ patch: null })}>放弃</Button>
              <Button size="sm" disabled={patchPending || saving} onClick={() => { void applyForeign(); }}>
                {patchPending ? '应用中…' : '应用调整'}
              </Button>
            </div>
          </section>
        )}

          {proposal && preview && (
            <section className="mx-3.5 mt-3 space-y-2 rounded-lg border border-site-line bg-site-bg p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', feasibilityCls[preview.feasibility] ?? feasibilityCls.UNKNOWN)}>
                  {feasibilityText[preview.feasibility] ?? preview.feasibility}
                </span>
                {unplacedList.length ? (
                  <span className="tabular text-[11px] text-site-ink-soft">缺口任务目标 {targetMin} 分钟 · 已排 {placedMin} · 未排 {missingMin}</span>
                ) : (
                  <span className="text-[11px] text-site-ink-soft">全部任务均可排入当前可安排时段</span>
                )}
                {preview._local && <span className="text-[10px] text-site-ink-soft">本地预估</span>}
              </div>
              {unplacedList.length > 0 && (
                <ul className="space-y-1">
                  {unplacedList.slice(0, 5).map((u) => (
                    <li key={u.task_key} className="rounded border border-site-line bg-site-surface px-2 py-1 text-[11px] leading-snug text-site-ink">
                      <span className="font-medium">{u.title}</span>：目标 {u.target_minutes} 分钟，已排 {u.placed_minutes} 分钟，缺 {u.missing_minutes} 分钟{u.reason ? ` · ${u.reason}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              {violationsList.length > 0 && (
                <ul className="space-y-1">
                  {violationsList.slice(0, 5).map((v, i) => {
                    const text = constraintForViolation(v.constraint_id);
                    return (
                      <li key={i} className="rounded border border-site-danger/40 bg-site-danger/5 px-2 py-1 text-[11px] leading-snug text-site-danger">
                        {v.reason}{text ? `（受影响约束：${text}）` : ''}{v.suggestion ? ` · 建议：${v.suggestion}` : ''}
                      </li>
                    );
                  })}
                </ul>
              )}
              {compromisesList.length > 0 && (
                <details className="text-[11px] text-site-ink-soft">
                  <summary className="cursor-pointer select-none">软约束妥协 {compromisesList.length} 项</summary>
                  <ul className="mt-1 space-y-0.5">
                    {compromisesList.slice(0, 6).map((c, i) => <li key={i}>· {c.reason}</li>)}
                  </ul>
                </details>
              )}
              {preview.proposal?.changes?.length > 0 && (
                <div className="rounded border border-site-warning/50 bg-site-warning/5 px-2 py-1.5">
                  <p className="text-[11px] leading-snug text-site-ink">可接受的取舍（需你确认，不会自动应用）：{preview.proposal.changes.join('；')}</p>
                  {preview.proposal.suggested && (
                    <Button variant="outline" size="sm" className="mt-1.5 h-7 px-2 text-[11px]" onClick={() => { change(preview.proposal.suggested); }}>
                      接受取舍建议
                    </Button>
                  )}
                </div>
              )}
            </section>
          )}

          <div className="max-h-[40vh] overflow-y-auto px-3.5 pb-3.5">
            <ConstraintSetBody
              draft={viewed}
              onChange={change}
              planStart={state.plan.horizon_start}
              footer={(
                <ConstraintSetFooter>
                  {proposal ? (
                    <>
                      <Button variant="outline" size="sm" onClick={() => { useChatStore.setState({ artifact: null, clarifications: [] }); close(); }}>取消</Button>
                      <Button size="sm" disabled={isPending || viewed.task_defs.length === 0 || preview?.feasibility === 'INFEASIBLE'} onClick={() => commit(viewed)}>
                        {isPending ? '生成中…' : '确认并生成'}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button variant="outline" size="sm" onClick={close}>关闭</Button>
                      {needsSchedule ? (
                        <Button size="sm" disabled={saving} onClick={() => { void saveAndGenerate(); }}>
                          {saving ? '生成中…' : '保存并生成排程'}
                        </Button>
                      ) : !unsaved ? (
                        <Button size="sm" disabled={saving} onClick={() => { void saveAndGenerate(); }}>
                          {saving ? '生成中…' : '保存并生成'}
                        </Button>
                      ) : null}
                    </>
                  )}
                </ConstraintSetFooter>
              )}
            />
            <SharedBusySection />
          </div>
          </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}