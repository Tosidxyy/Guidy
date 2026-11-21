// Browser-only P0/P1/P2 real-AI regression. No synthetic artifacts, repairs, DB clearing, or history writes.
import React, { useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '/lib/queryClient.ts';
import { useCommitPlan } from '/lib/useCommitPlan.ts';
import { useApplyPatch } from '/lib/useApplyPatch.ts';
import { usePlanManager } from '/lib/usePlanManager.ts';
import { usePlanLayers, useSharedBusyLoader } from '/lib/usePlanLayers.ts';
import { chatController } from '/lib/chatRuntime.ts';
import { planController } from '/lib/planRuntime.ts';
import { useChatStore, cursorAfterMessages } from '/store/useChatStore.ts';
import { restoreChat } from '/lib/restoreChat.ts';
import { usePlanStore } from '/store/usePlanStore.ts';
import { useSharedCalendar } from '/store/useSharedCalendar.ts';
import { useBlockHistory, flushBlockHistoryWrites } from '/store/useBlockHistory.ts';
import { localPlan, localPlans, localCalendar, localHistory, MATERIALIZED_NOTE } from '/lib/local/domain.ts';
import { listPlans, listShared, getBlockHistory } from '/lib/local/repo.ts';
import { applyPatch, validatePlacement } from '/shared/engine/index.ts';
import { dayList, localDay, localMinutes, utcAt, weekdayOfDay } from '/shared/engine/time.ts';

export const usage = `P0/P1/P2 full real-model regression: original plan, travel, second plan, math, vocabulary, manual move, reload + undo/redo, fallback.
Use a clean browser profile on local Vite, with real function-live running; do not interact while running.
Tutoring conflicts allow ONE explicit user-consent patch on A, then ONE reply in the original new-B conversation; no model repairs/retries.
window.p0 = await import('/scripts/regression-p0.mjs');
void (window.p0Job = p0.runBeforeReload().catch(e => console.error(e))); // launch without awaiting in MCP
p0.getReport(); // progress, exact AI output, previews, snapshots, failures
// Once getReport().reload.ready is true, perform an ACTUAL browser reload (even if semantic checks failed).
window.p0 = await import('/scripts/regression-p0.mjs');
void (window.p0Job = p0.runAfterReload().catch(e => console.error(e)));
// After it settles, externally restart function-live with invalid primary + valid backup credentials.
void (window.p0Job = p0.runFallback().catch(e => console.error(e)));
p0.getReport();
No credentials are read or configured here. No data is deleted. Manual move is programmatic, NOT pointer drag.
DOM clicks only reveal UI for text checks; they do NOT prove native inert behavior or physical pointer interactions.
A new run requires an empty plans/shared DB and a fresh sessionStorage report (use a separate clean profile).`;

const KEY = 'guidy:regression-p0:v1';
const LOCK = Symbol.for('guidy.regression-p0.running');
const PAGE = typeof performance === 'undefined' ? null : performance.timeOrigin;
const POLL_MS = 250;
const TIMEOUT_MS = 180_000;
const TEXT = {
  original: '我是大三学生，周一到周五上午 8 点到 12 点有课，周三晚上 7 点到 9 点有选修课。下周六周日去杭州旅游两天，那两天不安排学习。平时每天要复习考研数学 2 小时、英语 1 小时，每周健身 3 次每次 1 小时，帮我排接下来两周',
  travel: '杭州旅游那两天帮我规划细一点，周六上午高铁过去，想逛西湖和灵隐寺，周日晚上回来',
  second: '我每周二、周四下午 1 点到 4 点要去做家教，另外每天想练 30 分钟吉他，别和我其他安排冲突',
  math: '把数学都挪到晚上 7 点以后',
  vocab: '再加一项：每天 30 分钟背单词',
  fallback: '你好，请只用一句话打个招呼，不要创建或修改任何计划，也不要调用工具。',
};
let report;
let bridge;
let root;
let mountNode;
let savedCommitId;

const copy = value => value === undefined ? null : JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
function requireThat(ok, message, details) {
  if (ok) return;
  const error = new Error(message);
  if (details !== undefined) error.details = copy(details);
  throw error;
}
function errorInfo(error) {
  return copy({ name: error?.name ?? 'Error', message: error?.message ?? String(error),
    code: error?.code, details: error?.details, diagnosticId: error?.diagnosticId, stack: error?.stack });
}
function browserOnly() {
  requireThat(typeof window !== 'undefined' && typeof document !== 'undefined' &&
    typeof indexedDB !== 'undefined', 'Run only in a real Vite browser with IndexedDB; no memory fallback.');
  requireThat(['localhost', '127.0.0.1', '[::1]'].includes(location.hostname),
    'Refusing a non-local origin. Use local Vite + real function-live.');
}
function load() {
  browserOnly();
  if (!report) report = JSON.parse(sessionStorage.getItem(KEY) || 'null');
  return report;
}
function save() {
  report.updatedAt = now();
  // Storage/quota errors are fatal, never silently lose reload evidence.
  sessionStorage.setItem(KEY, JSON.stringify(report));
}
export function getReport() {
  browserOnly();
  return copy(JSON.parse(sessionStorage.getItem(KEY) || 'null'));
}
function freshReport() {
  return { schema: 1, runId: crypto.randomUUID(), startedAt: now(), origin: location.origin,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    suite: 'P0/P1/P2 full 8-step regression',
    phases: {}, steps: [], snapshots: {}, chats: {}, mutations: [], ids: {}, reload: { ready: false },
    policies: { pollMs: POLL_MS, timeoutMs: TIMEOUT_MS, artifacts: 'unmodified real AI outputs',
      comparisons: 'full blocks/task_defs/constraints; ignore plan version/created_at/updated_at only',
      move: 'programmatic move_block through planController.apply, not pointer drag',
      ui: 'rendered DOM text/attributes only; native inert and physical drag require external browser testing',
      confirmation: 'scripted user consent; at most one tutoring-resolution patch and one B follow-up',
      failures: 'semantic failures recorded and continued; mutation/transport failures stop phase' } };
}
async function bounded(promise, label, timeout = TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: exceeded ${timeout}ms`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}
async function poll(label, test) {
  const end = Date.now() + TIMEOUT_MS;
  let revision = 0;
  let wake;
  const notify = () => { revision++; wake?.(); };
  const subscriptions = [useChatStore.subscribe(notify), usePlanStore.subscribe(notify), useBlockHistory.subscribe(notify),
    queryClient.getQueryCache().subscribe(notify), queryClient.getMutationCache().subscribe(notify)];
  const observer = new MutationObserver(notify);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  try {
    while (Date.now() < end) {
      const before = revision;
      const result = await bounded(Promise.resolve().then(test), label, Math.max(1, end - Date.now()));
      if (result) return result;
      if (before !== revision) continue;
      await new Promise(resolve => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, Math.min(POLL_MS, Math.max(0, end - Date.now())));
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    }
    throw new Error(`${label}: timed out after ${TIMEOUT_MS}ms`);
  } finally {
    wake?.();
    subscriptions.forEach(unsubscribe => unsubscribe());
    observer.disconnect();
  }
}
async function step(name, fn, { soft = false } = {}) {
  const entry = { phase: report.activePhase, name, status: 'running', startedAt: now(), evidence: {} };
  report.steps.push(entry);
  save();
  const evidence = value => { Object.assign(entry.evidence, copy(value)); save(); };
  try {
    const result = await fn(evidence);
    entry.status = 'passed';
    entry.finishedAt = now();
    save();
    console.info(`[p0] PASS ${name}`);
    return result;
  } catch (error) {
    entry.status = 'failed';
    entry.finishedAt = now();
    entry.error = errorInfo(error);
    save();
    console.error(`[p0] FAIL ${name}: ${entry.error.message}`);
    if (!soft) throw error;
    return null;
  }
}
async function phase(name, fn) {
  browserOnly();
  requireThat(!globalThis[LOCK], `Another p0 phase is running: ${globalThis[LOCK]}`);
  load();
  if (!report) { report = freshReport(); save(); }
  requireThat(!report.phases[name], `${name} already attempted; inspect the existing report. No automatic retries.`);
  globalThis[LOCK] = name;
  report.activePhase = name;
  report.phases[name] = { status: 'running', startedAt: now(), page: PAGE };
  save();
  try {
    await fn();
    const failures = report.steps.filter(s => s.phase === name && s.status === 'failed');
    requireThat(!failures.length, `${name}: ${failures.length} failed check(s); see getReport().steps`, failures.map(s => s.name));
    report.phases[name].status = 'passed';
  } catch (error) {
    report.phases[name].status = 'failed';
    report.phases[name].error = errorInfo(error);
    throw error;
  } finally {
    report.phases[name].finishedAt = now();
    report.activePhase = null;
    delete globalThis[LOCK];
    save();
  }
  return getReport();
}

// Object keys and collection order are canonicalized; block fields/IDs/origins/notes are NOT stripped.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, stable(value[key])]));
  return value;
}
const json = value => JSON.stringify(stable(value));
const sorted = values => [...values].sort((a, b) => json(a).localeCompare(json(b)));
function planView(state) {
  const { version, created_at, updated_at, task_defs, constraints, blocks, ...meta } = state.plan;
  return { plan: meta, blocks: sorted(state.blocks), task_defs: sorted(state.task_defs), constraints: sorted(state.constraints) };
}
function worldView(snapshot) {
  return { plans: sorted(snapshot.plans.map(planView)), shared: sorted(snapshot.shared) };
}
function mismatch(actual, expected, path = '$') {
  if (json(actual) === json(expected)) return null;
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object')
    return { path, actual, expected };
  for (const key of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
    const diff = mismatch(actual[key], expected[key], `${path}.${key}`);
    if (diff) return diff;
  }
  return { path, actual, expected };
}
function equal(actual, expected, label) {
  const diff = mismatch(stable(actual), stable(expected));
  requireThat(!diff, `${label}: canonical mismatch`, diff);
}
function historyView() {
  const h = useBlockHistory.getState();
  return copy({ entries: h.entries, redo: h.redo });
}
const planHistory = (h, id) => ({ entries: h.entries[id] ?? [], redo: h.redo[id] ?? [] });
async function historyDurable() {
  await bounded(flushBlockHistoryWrites(), 'flush history');
  const stored = await bounded(getBlockHistory(), 'read persisted history');
  equal(stored, historyView(), 'Persisted history vs store');
  return stored;
}

function HookBridge() {
  const commit = useCommitPlan(id => {
    savedCommitId = id;
    useChatStore.setState({ artifact: null, clarifications: [] }); // Same post-save callback as the UI.
  });
  const patch = useApplyPatch();
  const manager = usePlanManager();
  const activeId = usePlanStore(s => s.state.plan.id);
  useSharedBusyLoader();
  const layers = usePlanLayers(activeId);
  useLayoutEffect(() => { bridge = { commit, patch, manager, layers }; });
  return null;
}
async function mount() {
  if (!root) {
    mountNode = document.createElement('div');
    mountNode.hidden = true;
    mountNode.dataset.regressionP0 = 'hooks';
    document.body.appendChild(mountNode);
    root = createRoot(mountNode);
    root.render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(HookBridge)));
  }
  await poll('mount real React mutation hooks', () => bridge && !bridge.manager.isLoading);
  requireThat(!bridge.manager.isError, 'Plan-manager query failed.');
}
async function refresh() {
  await bounded(Promise.all(['plans', 'plan', 'calendar'].map(key =>
    queryClient.invalidateQueries({ queryKey: [key] }))), 'refresh application queries');
  const calendar = await bounded(localCalendar(), 'read shared calendar');
  // The real shared loader normalizes these two UI-only fields; never set the store ourselves.
  const expectedShared = sorted(calendar.blocks.map(b => ({ ...b, pinned: false, origin: 'manual' })));
  await poll('shared/layer readers settle', () => !bridge.manager.isPending && !bridge.layers.isLoading &&
    json(sorted(useSharedCalendar.getState().busyBlocks)) === json(expectedShared));
}
async function snapshot(name) {
  const states = [];
  for (const item of (await bounded(localPlans(), 'list persisted plans')).items) {
    const state = await bounded(localPlan(item.id), 'read persisted plan');
    // localPlan.plan is a PlanRecord containing duplicate arrays; keep those arrays once, in full.
    const { task_defs, constraints, blocks, ...meta } = state.plan;
    states.push({ ...state, plan: meta });
  }
  const shared = (await bounded(localCalendar(), 'read persisted shared blocks')).blocks;
  // Retain raw IndexedDB rows as the authority too: domain readers must not hide ghost blocks.
  const [records, rawShared] = await bounded(Promise.all([listPlans(), listShared()]), 'audit raw IndexedDB rows');
  const rawStates = records.map(({ task_defs, constraints, blocks, ...plan }) => ({ plan, task_defs, constraints, blocks }));
  const domainReadMismatch = mismatch(worldView({ plans: states, shared }), worldView({ plans: rawStates, shared: rawShared }));
  const snap = copy({ capturedAt: now(), activePlanId: usePlanStore.getState().state.plan.id,
    plans: rawStates, shared: rawShared, domainReadMismatch });
  report.snapshots[name] = snap;
  save();
  requireThat(!domainReadMismatch, 'localPlan/localCalendar differ from raw persisted rows; snapshot retained', domainReadMismatch);
  return snap;
}
async function manage(kind, id) {
  await step(kind === 'newPlan' ? 'manager.newPlan' : `manager.switchPlan(${id})`, async evidence => {
    const before = historyView();
    await bounded(bridge.manager[kind](id), `usePlanManager.${kind}`);
    await poll('manager settles with expected ID', () => !bridge.manager.isPending &&
      usePlanStore.getState().state.plan.id === (kind === 'newPlan' ? null : id));
    await refresh();
    equal(historyView(), before, 'Switch/new-plan must not modify histories');
    if (id) {
      const persisted = await bounded(localPlan(id), 'verify switched plan');
      equal(planView(usePlanStore.getState().state), planView(persisted), 'Switched plan vs IndexedDB');
      const chat = useChatStore.getState();
      requireThat(chat.conversationId && !chat.streaming && !chat.queued.length && !chat.error,
        'Plan switched but its conversation did not settle', chatEvidence(0));
      const restored = await bounded(localHistory(chat.conversationId), 'verify switched conversation');
      requireThat(restored.conversation.plan_id === id, 'Manager swallowed a conversation-restore failure or restored the wrong plan',
        { expectedPlanId: id, conversation: restored.conversation });
      // restoreChat intentionally hides system rows and already-applied cards, not text bubbles.
      const textBubbles = messages => persistedMessages(messages.filter(m => m.role !== 'system' && m.kind === 'text'));
      equal(textBubbles(chat.messages), textBubbles(restored.messages), 'Switched conversation text vs IndexedDB');
      await checkPersistedNotices(`switch ${id}`);
    } else {
      requireThat(!useChatStore.getState().conversationId, 'newPlan did not create a fresh conversation');
    }
    evidence({ planId: usePlanStore.getState().state.plan.id, conversationId: useChatStore.getState().conversationId });
  });
}
function chatEvidence(startIndex) {
  const s = useChatStore.getState();
  const messages = s.messages.slice(startIndex);
  return copy({ conversationId: s.conversationId, requestId: s.requestId, streaming: s.streaming,
    connection: s.connection, queued: s.queued, error: s.error, messages,
    assistantText: messages.filter(m => m.role === 'assistant' && m.kind === 'text').map(m => m.content),
    statusText: messages.filter(m => m.kind === 'status').map(m => m.content),
    artifact: s.artifact, patch: s.patch, artifactPreview: s.artifactPreview, patchPreview: s.patchPreview,
    localPreview: usePlanStore.getState().preview, lastCompromises: usePlanStore.getState().lastCompromises,
    question: s.question, clarifications: s.clarifications });
}
const persistedMessages = messages => messages.filter(m => !(m.role === 'user' && m.seq === -1) &&
  !(m.role === 'assistant' && m.kind === 'text' && !m.content)).map(m =>
  ({ role: m.role, kind: m.kind, content: m.content, payload: m.payload ?? null }));
const chatRegion = () => document.querySelector('aside[aria-label="AI 对话排程"] [aria-live="polite"]');
const renderedText = node => node && !node.closest('[inert], [hidden], [aria-hidden="true"]') &&
  node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ? node.innerText : '';
const compact = text => text.replace(/\s+/g, '');
async function checkPersistedNotices(name) {
  await step(`UI: persisted compromise/preview text (${name})`, async evidence => {
    const id = useChatStore.getState().conversationId;
    const notices = [...new Set(Object.values(report.chats).filter(c => c.ui?.conversationId === id)
      .flatMap(c => [c.ui.delivered?.artifactPreview, c.ui.delivered?.patchPreview])
      .flatMap(p => [...(p?.notes ?? []), ...(p?.compromises ?? []).map(c => c.reason)]).filter(Boolean))];
    evidence({ conversationId: id, notices, applicable: !!notices.length });
    if (!notices.length) return; // No invented compromise and no claim that this branch was exercised.
    const h = await bounded(localHistory(id), 'read persisted preview notices');
    const persisted = h.messages.filter(m => ['constraint_set', 'patch'].includes(m.kind)).map(m => m.content ?? '').join('\n');
    const visible = renderedText(chatRegion());
    evidence({ persisted, visible });
    requireThat(notices.every(n => compact(persisted).includes(compact(n))), 'Preview/compromise text missing from persisted artifact messages');
    requireThat(notices.every(n => compact(visible).includes(compact(n))), 'Persisted preview/compromise text missing from rendered chat (toasts do not count)');
  }, { soft: true });
}
async function checkTravelLabels(name, snapshot) {
  await step(`UI: dated shared travel labels (${name})`, async evidence => {
    const travel = snapshot.shared.filter(b => /杭州|旅游|旅行|西湖|灵隐|高铁/.test(b.title) && touchesTravel(b, report.timezone));
    evidence({ applicable: !!travel.length, blocks: travel, interaction: 'programmatic card toggle only, not a native inert test' });
    if (!travel.length) return;
    const toggle = [...document.querySelectorAll('aside button[aria-controls][aria-expanded]')].find(b => b.textContent.includes('方案卡'));
    requireThat(toggle && renderedText(toggle), 'Plan-card toggle is not rendered');
    const wasOpen = toggle.getAttribute('aria-expanded') === 'true';
    const body = document.getElementById(toggle.getAttribute('aria-controls'));
    evidence({ initialExpanded: wasOpen, initialInertAttribute: body?.hasAttribute('inert') });
    try {
      if (!wasOpen) toggle.click();
      await poll('reveal plan card for dated-label check', () => toggle.getAttribute('aria-expanded') === 'true' && renderedText(body));
      const labels = [...body.querySelectorAll('section li > div > span')].map(renderedText).filter(Boolean);
      evidence({ labels });
      for (const b of travel) requireThat(labels.some(t => t.includes(b.title) &&
        t.includes(localDay(b.start_utc, report.timezone)) && !t.includes('每周')),
      'One-off travel needs a concrete date label, not a weekly recurrence label', b);
    } finally {
      if (!wasOpen && toggle.getAttribute('aria-expanded') === 'true') toggle.click();
    }
  }, { soft: true });
}
async function send(name, text, expected) {
  return step(`AI: ${name}`, async evidence => {
    await refresh();
    const before = useChatStore.getState();
    requireThat(!before.streaming && !before.queued.length, 'Refusing to interrupt or queue behind another chat.');
    const start = before.messages.length;
    const oldRequest = before.requestId;
    report.chats[name] = { prompt: text, sentAt: now() };
    save();
    let observedStart = false;
    let lastCapture;
    const delivered = { artifact: null, patch: null, question: null, artifactPreview: null, patchPreview: null };
    const unsubscribe = useChatStore.subscribe(s => {
      const thisTurn = s.messages.slice(start).some(m => m.role === 'user' && m.content === text);
      if (s.streaming && thisTurn) observedStart = true;
      if (!observedStart || !thisTurn) return;
      // PlanCardPanel may immediately consume a task-only patch into its private draft and clear
      // store.patch. Retain the exact emitted object here, BEFORE React effects; do not rebuild it.
      for (const key of Object.keys(delivered)) if (s[key] != null) delivered[key] = s[key];
    });
    const capture = () => {
      const current = { ...chatEvidence(start), delivered: copy(delivered) };
      const signature = json(current);
      if (signature !== lastCapture) {
        report.chats[name].ui = current;
        save();
        lastCapture = signature;
      }
      return current;
    };
    try {
      chatController.send(text); // Returns void; NEVER treat this as completion.
      await poll(`real chat ${name}`, () => {
        const ui = capture();
        requireThat(!ui.error, `Chat ${name} failed: ${ui.error?.message}`, ui.error);
        const acceptedUser = ui.messages.some(m => m.role === 'user' && m.content === text && m.seq >= 0);
        const assistant = ui.messages.some(m => m.role === 'assistant');
        const finished = observedStart && acceptedUser && assistant && ui.conversationId && ui.requestId &&
          ui.requestId !== oldRequest && !ui.streaming && !ui.queued.length && ui.connection === 'idle';
        return finished;
      });
      const ui = capture();
      evidence({ chat: name, conversationId: ui.conversationId, requestId: ui.requestId });
      // Stream completion precedes asynchronous conversation persistence. Wait before switching/reloading.
      const expectedMessages = persistedMessages(useChatStore.getState().messages);
      await poll(`persist chat ${name}`, async () => {
        const h = await localHistory(ui.conversationId);
        return json(persistedMessages(h.messages)) === json(expectedMessages);
      });
      requireThat(ui.assistantText.some(t => t.trim()), `AI ${name} returned no assistant text`, ui);
      await checkPersistedNotices(`AI ${name}`);
      if (expected === 'artifact') requireThat(delivered.artifact?.type === 'constraint_set' && !delivered.question && !delivered.patch,
        'Expected only a real constraint_set, not a question/text-only response; no automatic follow-up', ui);
      if (expected === 'artifact-or-question') {
        requireThat(!delivered.patch && (Number(delivered.artifact?.type === 'constraint_set') +
          Number(delivered.question?.type === 'question_card') === 1),
        'Expected exactly one real constraint_set OR question_card, never an overlapping plan alongside a question', ui);
        return delivered.artifact ?? delivered.question;
      }
      if (expected === 'patch') requireThat(delivered.patch?.type === 'patch' && delivered.patch.ops.length && !delivered.question && !delivered.artifact,
        'Expected only a real nonempty patch; no automatic follow-up', ui);
      return expected === 'artifact' ? delivered.artifact : expected === 'patch' ? delivered.patch : ui;
    } finally { capture(); unsubscribe(); }
  });
}
async function mutate(name, kind, artifact) {
  return step(`${kind}: ${name}`, async evidence => {
    const before = await snapshot(`${name}.before`);
    const historyBefore = await historyDurable();
    evidence({ before: `${name}.before` });
    const previousId = usePlanStore.getState().state.plan.id;
    const previousVersion = usePlanStore.getState().state.plan.version;
    const cache = queryClient.getMutationCache();
    const oldMutations = new Set(cache.getAll());
    savedCommitId = null;
    let mutation;
    try {
      if (kind === 'commit') bridge.commit.commit(artifact);
      else bridge.patch.apply(artifact);
      await poll(`${kind} mutation settlement`, () => {
        mutation = cache.getAll().find(m => !oldMutations.has(m) && m.state.variables === artifact);
        if (mutation?.state.status === 'error') throw mutation.state.error;
        const hook = kind === 'commit' ? bridge.commit : bridge.patch;
        if (hook.error) throw hook.error;
        if (mutation?.state.status !== 'success' || hook.isPending) return false;
        const current = usePlanStore.getState().state.plan;
        if (kind === 'commit') return savedCommitId && current.id === savedCommitId &&
          (current.id !== previousId || current.version > previousVersion) && !useChatStore.getState().artifact;
        // Shared-only patches legitimately do not advance the active plan's version.
        const response = mutation.state.data?.resp;
        return current.id === previousId && !useChatStore.getState().patch &&
          (!response || (current.version > previousVersion && current.version === response.version));
      });
      await refresh();
      const after = await snapshot(`${name}.after`);
      evidence({ after: `${name}.after`, warnings: mutation.state.data?.resp?.warnings ?? [],
        compromises: mutation.state.data?.resp?.compromises ?? [],
        planNotes: usePlanStore.getState().lastCompromises });
      requireThat(json(worldView(before)) !== json(worldView(after)), 'Mutation reported success but changed no persisted content');
      const active = await localPlan(usePlanStore.getState().state.plan.id);
      equal(planView(active), planView(usePlanStore.getState().state), 'Hook result vs persisted plan');
      requireThat(active.plan.version === usePlanStore.getState().state.plan.version,
        'Hook version differs from IndexedDB', { persisted: active.plan.version, ui: usePlanStore.getState().state.plan.version });
      const history = await historyDurable();
      const previous = planHistory(historyBefore, active.plan.id);
      const current = planHistory(history, active.plan.id);
      evidence({ historyDepth: current.entries.length, previousHistoryDepth: previous.entries.length });
      requireThat(current.entries.length === previous.entries.length + 1 && !current.redo.length,
        'Mutation must append exactly one genuine history action', { previous, current });
      equal(current.entries.slice(0, -1), previous.entries, 'Mutation preserves earlier history actions');
      const { label, at } = current.entries.at(-1);
      report.mutations.push({ name, kind, planId: active.plan.id, before: `${name}.before`, after: `${name}.after`,
        historyIndex: current.entries.length - 1, label, at });
      save();
      return after;
    } catch (error) {
      // Preserve partial writes too; never roll back or manufacture a history entry.
      try { await snapshot(`${name}.failed`); evidence({ failedSnapshot: `${name}.failed` }); }
      catch (captureError) { evidence({ snapshotError: errorInfo(captureError) }); }
      throw error;
    }
  });
}

const live = b => b.status !== 'cancelled' && b.status !== 'skipped';
const overlaps = (a, b) => Date.parse(a.start_utc) < Date.parse(b.end_utc) && Date.parse(b.start_utc) < Date.parse(a.end_utc);
const addDays = (day, count) => new Date(Date.parse(`${day}T12:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10);
function requestedTravelDays() {
  const today = localDay(now(), report.timezone);
  const offset = (weekdayOfDay(today, report.timezone) + 6) % 7;
  return [addDays(today, 12 - offset), addDays(today, 13 - offset)];
}
function touchesTravel(block, tz) {
  return report.travelDays.some(day => overlaps(block, { start_utc: utcAt(day, 0, tz), end_utc: utcAt(day, 1440, tz) }));
}
const named = (b, pattern, state) => pattern.test(`${b.title} ${b.task_key ?? ''} ${state?.task_defs.find(t => t.key === b.task_key)?.title ?? ''}`);
const MATH = /数学|math/i;
const VOCAB = /背单词|单词|词汇|vocab|word/i;
function rowsOf(snapshot) {
  return [...snapshot.plans.flatMap(state => state.blocks.map(block => ({ block, state, owner: state.plan.id,
    task: !!block.task_key || (block.origin !== 'fixed' && !block.notes?.includes(MATERIALIZED_NOTE)) }))),
  ...snapshot.shared.map(block => ({ block, owner: 'shared', task: false }))];
}
function outsideQuiet(block, tz) {
  const start = localDay(block.start_utc, tz);
  const last = localDay(new Date(Date.parse(block.end_utc) - 1).toISOString(), tz);
  return start === last && localMinutes(block.start_utc, tz) >= 360 &&
    Date.parse(block.end_utc) <= Date.parse(utcAt(start, 1380, tz));
}
function dailyMinutes(state, pattern) {
  return Object.fromEntries(dayList(state.plan.horizon_start, state.plan.horizon_days, state.plan.timezone).map(day => {
    const start = Date.parse(utcAt(day, 0, state.plan.timezone));
    const end = Date.parse(utcAt(day, 1440, state.plan.timezone));
    const minutes = state.blocks.filter(b => live(b) && named(b, pattern, state)).reduce((sum, b) =>
      sum + Math.max(0, Math.min(end, Date.parse(b.end_utc)) - Math.max(start, Date.parse(b.start_utc))) / 60_000, 0);
    return [day, minutes];
  }));
}
async function validate(name, snapshotName, { math = false, vocab = false, replacement = false } = {}) {
  await step(`assert layout: ${name}`, async evidence => {
    const snapshot = report.snapshots[snapshotName];
    const rows = rowsOf(snapshot).filter(r => live(r.block));
    const issues = [];
    const check = (ok, rule, detail) => { if (!ok) issues.push({ rule, detail }); };
    for (const row of rows) {
      const b = row.block;
      check(Number.isFinite(Date.parse(b.start_utc)) && Date.parse(b.end_utc) > Date.parse(b.start_utc), 'valid interval', b);
      if (b.origin === 'engine') check(outsideQuiet(b, row.state?.plan.timezone ?? report.timezone), 'no engine block in 23:00–06:00', b);
      if (name === 'original commit' && b.origin === 'engine') check(Date.parse(b.start_utc) >= Date.parse(report.steps.find(s => s.name === 'commit: A.commit').startedAt), 'new allocation never starts before the commit clock', b);
      const learning = row.task && (!!b.task_key || b.category === 'study' || named(b, /数学|英语|复习|背单词|词汇|吉他|math|english|vocab|guitar/i, row.state));
      if (learning) check(!touchesTravel(b, row.state?.plan.timezone ?? report.timezone), 'no learning on travel dates', b);
    }
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      if (!rows[i].task && !rows[j].task) continue; // Redundant busy constraints may overlap.
      check(!overlaps(rows[i].block, rows[j].block), 'no task/task, task/foreign, or task/shared overlap',
        { first: { owner: rows[i].owner, block: rows[i].block }, second: { owner: rows[j].owner, block: rows[j].block } });
    }
    const a = snapshot.plans.find(p => p.plan.id === report.ids.A);
    check(!!a, 'original plan remains in IndexedDB', report.ids.A);
    if (report.ids.B) check(snapshot.plans.some(p => p.plan.id === report.ids.B), 'second plan remains in IndexedDB', report.ids.B);
    if (a) {
      const days = dayList(a.plan.horizon_start, a.plan.horizon_days, a.plan.timezone);
      check(a.plan.horizon_days === 14 && report.travelDays.every(d => days.includes(d)), 'two-week horizon covers requested next-weekend trip', a.plan);
      if (math) {
        const blocks = a.blocks.filter(b => live(b) && named(b, MATH, a));
        check(blocks.length > 0, 'math must not disappear', a.task_defs);
        check(blocks.every(b => localMinutes(b.start_utc, a.plan.timezone) >= 19 * 60 && outsideQuiet(b, a.plan.timezone)), 'all math at/after 19:00', blocks);
        const baseline = report.snapshots['math.before'].plans.find(p => p.plan.id === report.ids.A);
        check(json(dailyMinutes(a, MATH)) === json(dailyMinutes(baseline, MATH)), 'math daily minutes preserved',
          { actual: dailyMinutes(a, MATH), expected: dailyMinutes(baseline, MATH) });
      }
      if (vocab) {
        const tasks = a.task_defs.filter(t => VOCAB.test(`${t.title} ${t.key}`));
        check(tasks.length > 0 && tasks.every(t => t.frequency.type === 'daily') &&
          tasks.reduce((sum, t) => sum + t.duration_min, 0) === 30, 'daily vocabulary definition target is 30 minutes', tasks);
        const minutes = dailyMinutes(a, VOCAB);
        for (const day of days) check(Math.abs(minutes[day] - (report.travelDays.includes(day) ? 0 : 30)) < 0.001,
          'daily vocab 30 minutes; travel days zero (no silent partial-day exemption)', { day, minutes: minutes[day] });
        evidence({ vocabularyMinutes: minutes });
      }
    }
    if (replacement) {
      const ids = new Set(rowsOf(snapshot).map(r => r.block.id));
      check(report.originalTravelIds?.length > 0, 'original shared travel blocks must exist', report.originalTravelIds);
      check(report.originalTravelIds?.every(id => !ids.has(id)), 'original shared travel block IDs are gone from all plans/shared', report.originalTravelIds);
      const travel = rows.filter(r => touchesTravel(r.block, r.state?.plan.timezone ?? report.timezone));
      for (const site of ['西湖', '灵隐']) check(travel.some(r => r.block.title.includes(site) || r.block.notes?.includes(site)),
        'trip refinement contains requested site', site);
    }
    evidence({ snapshot: snapshotName, blockCount: rows.length, travelDays: report.travelDays, issues });
    requireThat(!issues.length, `${issues.length} layout assertion(s) failed`, issues);
  }, { soft: true });
}
async function compareWorld(name, snapshotName, expected) {
  await step(name, evidence => {
    evidence({ actual: snapshotName });
    equal(worldView(report.snapshots[snapshotName]), worldView(expected), name);
  }, { soft: true });
}

function tutoringClashes(snapshot) {
  const a = snapshot.plans.find(p => p.plan.id === report.ids.A);
  const windows = dayList(a.plan.horizon_start, a.plan.horizon_days, a.plan.timezone)
    .filter(day => [2, 4].includes(weekdayOfDay(day, a.plan.timezone)))
    .map(day => ({ start_utc: utcAt(day, 780, a.plan.timezone), end_utc: utcAt(day, 960, a.plan.timezone) }));
  return rowsOf(snapshot).filter(r => r.owner === report.ids.A && r.task && live(r.block) &&
    windows.some(w => overlaps(r.block, w))).map(r => r.block);
}
async function secondArtifact() {
  const before = await snapshot('second.before');
  const historyBefore = await historyDurable();
  const response = await send('second', TEXT.second, 'artifact-or-question');
  if (response.type === 'constraint_set') return response;
  const conversationId = useChatStore.getState().conversationId;
  const afterQuestion = await snapshot('second.question');
  const clashes = tutoringClashes(before);
  report.conflictResolution = { conversationId, questionChat: 'second', before: 'second.before', afterQuestion: 'second.question', clashes };
  save();
  await step('tutoring question leaves plans/shared/history unchanged', async evidence => {
    evidence(report.conflictResolution);
    equal(sorted(afterQuestion.plans), sorted(before.plans), 'Question leaves raw plan rows unchanged (including versions)');
    equal(sorted(afterQuestion.shared), sorted(before.shared), 'Question leaves shared rows unchanged');
    equal(await historyDurable(), historyBefore, 'Question leaves genuine histories unchanged');
    requireThat(clashes.length, 'Question did not identify a resolvable A tutoring clash; no speculative repair');
  });
  await step('UI: conflict question has concrete dates/titles and three choices', async evidence => {
    const visible = await poll('wait for rendered conflict question', () => renderedText(document.querySelector('[role="dialog"][aria-label="待确认的问题"]')) || false);
    const options = ['先调整已有安排', '修改新安排的时间', '暂不添加新安排'];
    const tz = before.plans.find(p => p.plan.id === report.ids.A).plan.timezone;
    evidence({ question: response, visible, clashes });
    requireThat(options.every(o => response.questions.some(q => q.options?.includes(o)) && visible.includes(o)),
      'Conflict choices are missing from the real question or rendered card');
    requireThat(visible.includes('家教') && /\d{1,2}:\d{2}/.test(visible) &&
      clashes.some(b => visible.includes(b.title) && visible.includes(localDay(b.start_utc, tz))),
    'Conflict card must visibly name tutoring, a real clashing task and its concrete date/time');
  }, { soft: true });
  await manage('switchPlan', report.ids.A);
  const consent = '先调整已有安排。我明确同意：只把当前计划中与每周二、周四下午13:00–16:00家教时段直接冲突的任务块移到其他空闲时间。逐块保持原时长和任务归属，不增删任务或修改任务定义、约束，不移动其他块或公共日历。杭州旅游两天仍不安排学习，也不要把这些任务移到旅游日或23:00–06:00。请返回这些块的真实移动 patch，现在不要添加家教或吉他。冲突块：' +
    clashes.map(b => `${b.id}「${b.title}」${b.start_utc}–${b.end_utc}`).join('；');
  const patch = await send('tutoring.resolve', consent, 'patch');
  await step('consented patch only moves the identified A clashes', evidence => {
    evidence({ chat: 'tutoring.resolve', allowedBlockIds: clashes.map(b => b.id) });
    for (const op of patch.ops) {
      const b = clashes.find(b => b.id === op.id);
      const times = op.op === 'move_block' ? op : op.patch;
      requireThat(b && (!op.plan_id || op.plan_id === report.ids.A) &&
        (op.op === 'move_block' || (op.op === 'update_block' && Object.keys(op.patch).every(k => ['start_utc', 'end_utc'].includes(k)))),
      'Refusing out-of-consent model operations; no artifact repair or retry', op);
      requireThat(Date.parse(times?.end_utc) - Date.parse(times?.start_utc) === Date.parse(b.end_utc) - Date.parse(b.start_utc),
        'Model must preserve each moved block duration', { op, b });
    }
  });
  const resolved = await mutate('tutoring.resolve', 'apply', patch);
  await step('old clashes actually resolved without unrelated changes', evidence => {
    const a = before.plans.find(p => p.plan.id === report.ids.A);
    const next = resolved.plans.find(p => p.plan.id === report.ids.A);
    const ids = new Set(clashes.map(b => b.id));
    evidence({ before: 'tutoring.resolve.before', after: 'tutoring.resolve.after', remaining: tutoringClashes(resolved) });
    equal(planView({ ...next, blocks: [] }), planView({ ...a, blocks: [] }), 'Consent preserves A definitions/constraints/metadata');
    equal(sorted(next.blocks.filter(b => !ids.has(b.id))), sorted(a.blocks.filter(b => !ids.has(b.id))), 'Consent preserves every unrelated A block');
    equal(sorted(resolved.shared), sorted(before.shared), 'Consent preserves shared calendar');
    requireThat(!tutoringClashes(resolved).length, 'Model left old tutoring clashes unresolved; stopping after one consent patch');
    for (const b of clashes) {
      const moved = next.blocks.find(x => x.id === b.id);
      requireThat(moved && moved.task_key === b.task_key && live(moved) &&
        Date.parse(moved.end_utc) - Date.parse(moved.start_utc) === Date.parse(b.end_utc) - Date.parse(b.start_utc) &&
        outsideQuiet(moved, a.plan.timezone) && !touchesTravel(moved, a.plan.timezone) &&
        dayList(a.plan.horizon_start, a.plan.horizon_days, a.plan.timezone).includes(localDay(moved.start_utc, a.plan.timezone)) &&
        !rowsOf(resolved).some(r => live(r.block) && r.block.id !== moved.id && overlaps(r.block, moved)),
      'Moved task must retain its duration/identity in a genuinely free non-travel slot', { before: b, after: moved });
    }
  });
  await validate('tutoring conflict resolved', 'tutoring.resolve.after', { replacement: true });
  await manage('newPlan');
  await step('restore original unbound B conversation from genuine persisted history', async evidence => {
    // The manager exposes plan switching only. Reuse the app's normal read-only chat restoration path.
    const h = await bounded(localHistory(conversationId), 'restore B question conversation');
    requireThat(!h.conversation.plan_id, 'B question conversation unexpectedly became bound to a plan', h.conversation);
    const restored = restoreChat(h.messages, usePlanStore.getState().state);
    useChatStore.getState().setConversation(conversationId, restored.messages);
    useChatStore.setState({ cursor: cursorAfterMessages(h.messages), artifact: restored.artifact,
      patch: restored.patch, question: restored.question, clarifications: restored.clarifications });
    equal(restored.question, response, 'Restored B question is the original real response');
    equal(persistedMessages(useChatStore.getState().messages), persistedMessages(h.messages.filter(m => m.role !== 'system')), 'B restores only persisted messages');
    evidence({ conversationId, messageCount: restored.messages.length, source: 'localHistory + restoreChat; no history writes' });
  });
  return send('second.confirmed', `我选择先调整已有安排，旧计划中与家教冲突的任务已按我的明确同意移到其他空闲时间，原时长和杭州旅游排除保持不变。现在在这个新对话继续创建独立的新计划，不再修改旧计划。再次确认原要求：${TEXT.second}`, 'artifact');
}

// Move B, so A's last three recorded AI actions remain the next three undo operations.
async function manualMove() {
  await manage('switchPlan', report.ids.B);
  await step('manual programmatic move_block on B (not pointer drag)', async evidence => {
    const before = await snapshot('manual.before');
    const state = before.plans.find(p => p.plan.id === report.ids.B);
    const obstacles = rowsOf(before).filter(r => live(r.block)).map(r => r.block);
    let chosen;
    for (const b of state.blocks.filter(b => live(b) && b.origin === 'engine' && !b.pinned)) {
      const day = localDay(b.start_utc, state.plan.timezone);
      if (report.travelDays.includes(day)) continue;
      const duration = Date.parse(b.end_utc) - Date.parse(b.start_utc);
      for (const delta of [15, -15, 30, -30, 60, -60, 90, -90, 120, -120]) {
        const start = Date.parse(b.start_utc) + delta * 60_000;
        const candidate = { ...b, start_utc: new Date(start).toISOString(), end_utc: new Date(start + duration).toISOString() };
        if (start < Date.now() || localDay(candidate.start_utc, state.plan.timezone) !== day ||
          !outsideQuiet(candidate, state.plan.timezone) || obstacles.some(o => o.id !== b.id && overlaps(o, candidate))) continue;
        const placement = validatePlacement(candidate, { ...state.plan, blocks: obstacles, constraints: state.constraints });
        if (placement.ok && !placement.soft.length) { chosen = { b, candidate }; break; }
      }
      if (chosen) break;
    }
    requireThat(chosen, 'No straightforward valid move for B; no artificial block or history will be synthesized.');
    const { b, candidate } = chosen;
    const op = { op: 'move_block', id: b.id, start_utc: candidate.start_utc, end_utc: candidate.end_utc };
    report.manual = { planId: state.plan.id, op, previousBlock: copy(b), before: 'manual.before', after: 'manual.after' };
    save();
    evidence({ op, previousBlock: b, before: 'manual.before' });
    const result = await bounded(planController.apply({ planId: state.plan.id, ops: [op],
      label: 'P0 手动移动（程序调用，非指针拖拽）', optimistic: { blocks: applyPatch(state, [op]).state.blocks } }), 'manual move');
    evidence({ result });
    const after = await snapshot('manual.after');
    requireThat(result.ok, `Manual move failed: ${result.reason}`, result);
    const persisted = after.plans.find(p => p.plan.id === state.plan.id);
    const moved = persisted.blocks.find(x => x.id === b.id);
    requireThat(moved?.start_utc === op.start_utc && moved?.end_utc === op.end_utc, 'Manual move missing in IndexedDB', moved);
    requireThat(persisted.plan.version > state.plan.version &&
      persisted.plan.version === usePlanStore.getState().state.plan.version, 'Manual move version did not persist/settle');
    await historyDurable();
    await refresh();
  });
  await validate('manual move', 'manual.after', { math: true, vocab: true, replacement: true });
  await manage('switchPlan', report.ids.A);
}

export function runBeforeReload() {
  return phase('beforeReload', async () => {
    await step('refuse nonempty plans/shared and existing unsaved work', async evidence => {
      // Raw repository reads FIRST: localCalendar/localPlan can migrate/materialize old constraints.
      const [plans, shared] = await bounded(Promise.all([listPlans(), listShared()]), 'read-only emptiness guard');
      evidence({ planCount: plans.length, sharedCount: shared.length });
      requireThat(!plans.length && !shared.length, 'Refusing nonempty plans/shared IndexedDB. Nothing will be deleted.');
      const state = usePlanStore.getState();
      const chat = useChatStore.getState();
      requireThat(!state.state.plan.id && !state.state.blocks.length && !state.state.task_defs.length && !state.dirty,
        'Refusing existing unsaved/stale plan work in the UI. Use a clean browser profile.');
      requireThat(!chat.streaming && !chat.queued.length && !chat.artifact && !chat.patch && !chat.question,
        'Refusing active chat or uncommitted artifact/patch/question.');
    });
    await step('mount hooks and hydrate real history', async () => {
      await mount();
      await bounded(flushBlockHistoryWrites(), 'flush history before hydrate');
      await bounded(useBlockHistory.getState().hydrate(), 'hydrate history');
      const h = await historyDurable();
      requireThat(!Object.values(h.entries).some(s => s.length) && !Object.values(h.redo).some(s => s.length),
        'Refusing orphaned history; use a clean profile, no clearing is performed.');
    });
    await manage('newPlan');
    report.travelDays = requestedTravelDays();
    save();
    const original = await send('original', TEXT.original, 'artifact');
    const initial = await mutate('A.commit', 'commit', original);
    report.ids.A = usePlanStore.getState().state.plan.id;
    report.originalTravelIds = initial.shared.filter(b => /杭州|旅游|旅行|出游/.test(b.title) &&
      touchesTravel(b, report.timezone)).map(b => b.id);
    save();
    await validate('original commit', 'A.commit.after');
    await checkTravelLabels('original commit', initial);
    await step('identify both original shared travel dates', evidence => {
      const blocks = initial.shared.filter(b => report.originalTravelIds.includes(b.id));
      evidence({ originalTravelIds: report.originalTravelIds, blocks });
      requireThat(report.travelDays.every(day => blocks.some(b => overlaps(b,
        { start_utc: utcAt(day, 0, report.timezone), end_utc: utcAt(day, 1440, report.timezone) }))),
      'Model did not materialize identifiable original shared travel blocks for both requested dates', blocks);
    }, { soft: true });
    await mutate('travel', 'apply', await send('travel', TEXT.travel, 'patch'));
    await validate('travel refinement', 'travel.after', { replacement: true });
    await manage('newPlan');
    await mutate('B.commit', 'commit', await secondArtifact());
    report.ids.B = usePlanStore.getState().state.plan.id;
    requireThat(report.ids.B !== report.ids.A, 'Second commit reused the original plan ID.');
    save();
    await step('B commit preserves A and existing shared blocks', () => {
      const before = report.snapshots['B.commit.before'];
      const after = report.snapshots['B.commit.after'];
      equal(planView(after.plans.find(p => p.plan.id === report.ids.A)), planView(before.plans.find(p => p.plan.id === report.ids.A)), 'B creation preserves A');
      const existing = new Set(before.shared.map(b => b.id));
      equal(sorted(after.shared.filter(b => existing.has(b.id))), sorted(before.shared), 'B creation preserves existing shared');
      report.bSharedAdditions = copy(after.shared.filter(b => !existing.has(b.id)));
      save();
    });
    await validate('second plan commit', 'B.commit.after', { replacement: true });
    await manage('switchPlan', report.ids.A);
    await mutate('math', 'apply', await send('math', TEXT.math, 'patch'));
    await validate('math moved', 'math.after', { math: true, replacement: true });
    await mutate('vocab', 'apply', await send('vocab', TEXT.vocab, 'patch'));
    await validate('vocabulary added', 'vocab.after', { math: true, vocab: true, replacement: true });
    await manualMove();
    await step('persist reload checkpoint and genuine history', async evidence => {
      report.historyBeforeReload = await historyDurable();
      const actions = report.mutations.filter(m => m.planId === report.ids.A);
      const aHistory = planHistory(report.historyBeforeReload, report.ids.A);
      requireThat(actions.length >= 4 && aHistory.entries.length === actions.length && !aHistory.redo.length,
        'Every A mutation must correspond to one genuine history entry (including any consent patch)', { actions, aHistory });
      equal(aHistory.entries.map(({ label, at }, historyIndex) => ({ label, at, historyIndex })),
        actions.map(({ label, at, historyIndex }) => ({ label, at, historyIndex })), 'A action order vs durable history');
      report.aHistoryTargets = copy(actions.slice(-3));
      evidence({ actualAMutations: actions, undoRedoTargets: report.aHistoryTargets });
      requireThat(planHistory(report.historyBeforeReload, report.ids.B).entries.length === 2,
        'B must have commit + real manual-move history entries', planHistory(report.historyBeforeReload, report.ids.B));
      await snapshot('beforeReload');
      report.reload = { ready: true, pageBefore: PAGE, checkpointAt: now() };
      evidence({ snapshot: 'beforeReload', readyForActualReload: true });
    });
  });
}

function expectedA(snapshotName) {
  const snapshot = copy(report.snapshots[snapshotName]);
  // B was created between A's earlier actions and math, then moved. Preserve its ACTUAL saved state.
  // The only shared overlay is B's recorded additive commit delta, never reconstructed undo ops.
  const b = report.snapshots['manual.after'].plans.find(p => p.plan.id === report.ids.B);
  const hadB = snapshot.plans.some(p => p.plan.id === report.ids.B);
  snapshot.plans = [...snapshot.plans.filter(p => p.plan.id !== report.ids.B), copy(b)];
  if (!hadB) snapshot.shared.push(...copy(report.bSharedAdditions));
  return snapshot;
}
async function historyOperation(direction, planId, name, expected, unchangedPlanId, action) {
  const beforeHistory = await historyDurable();
  const from = direction === 'undo' ? 'entries' : 'redo';
  const to = direction === 'undo' ? 'redo' : 'entries';
  const beforeStack = planHistory(beforeHistory, planId);
  const top = beforeStack[from].at(-1);
  requireThat(top, `${name}: no genuine history entry`);
  await step(name, async evidence => {
    await snapshot(`${name}.before`);
    evidence({ before: `${name}.before`, expectedTopLabel: top.label, recordedAction: action });
    if (action) equal({ label: top.label, at: top.at }, { label: action.label, at: action.at }, `${name} targets the actual recorded action`);
    const result = await bounded(planController[`${direction}Detailed`](planId), name);
    evidence({ result });
    await snapshot(`${name}.after`);
    requireThat(result.label && !result.reason, `${name} failed: ${result.reason ?? 'empty history'}`, result);
    equal(result.label, top.label, `${name} consumed the expected history label`);
    await refresh();
  });
  await compareWorld(`${name}: full IndexedDB snapshot`, `${name}.after`, expected);
  await step(`${name}: persisted stack transfer and other-plan isolation`, async evidence => {
    const h = await historyDurable();
    const current = planHistory(h, planId);
    equal(current[from], beforeStack[from].slice(0, -1), `${name} source stack`);
    equal(current[to], [...beforeStack[to], top], `${name} destination stack`);
    equal(planHistory(h, unchangedPlanId), planHistory(beforeHistory, unchangedPlanId), `${name} leaves other history untouched`);
    evidence({ entries: current.entries.length, redo: current.redo.length, unchangedPlanId });
  }, { soft: true });
}
export function runAfterReload() {
  return phase('afterReload', async () => {
    await step('require actual reload and hydrate durable history', async evidence => {
      requireThat(report.reload.ready, 'Before-reload sequence did not reach its checkpoint.');
      requireThat(report.reload.pageBefore !== PAGE, 'An actual browser reload is required; re-importing is not a reload.');
      requireThat(report.origin === location.origin, 'Reload must retain the same browser origin/session.');
      await mount();
      await bounded(flushBlockHistoryWrites(), 'flush before reload hydration');
      await bounded(useBlockHistory.getState().hydrate(), 'hydrate IndexedDB block history after reload');
      const h = await historyDurable();
      equal(h, report.historyBeforeReload, 'History survived actual reload');
      evidence({ pageBefore: report.reload.pageBefore, pageAfter: PAGE });
    });
    await manage('switchPlan', report.ids.A);
    await snapshot('afterReload.initial');
    await compareWorld('reload preserves both full plans and shared calendar', 'afterReload.initial', report.snapshots.beforeReload);
    await checkTravelLabels('after actual reload', report.snapshots['afterReload.initial']);
    // Last three ACTUAL A actions: an optional consent patch changes the undo/redo boundary.
    requireThat(report.aHistoryTargets?.length === 3, 'Missing three recorded A action targets; never guess history');
    for (const direction of ['undo', 'redo']) {
      const actions = direction === 'undo' ? [...report.aHistoryTargets].reverse() : report.aHistoryTargets;
      for (const action of actions) await historyOperation(direction, report.ids.A, `A.${direction}.${action.name}`,
        expectedA(action[direction === 'undo' ? 'before' : 'after']), report.ids.B, action);
    }
    await manage('switchPlan', report.ids.B);
    await snapshot('B.switched');
    await compareWorld('switch B preserves final A/B/shared', 'B.switched', report.snapshots.beforeReload);
    await historyOperation('undo', report.ids.B, 'B.undo.manual', report.snapshots['manual.before'], report.ids.A);
    await historyOperation('redo', report.ids.B, 'B.redo.manual', report.snapshots['manual.after'], report.ids.A);
    await manage('switchPlan', report.ids.A);
    await snapshot('afterReload.final');
    await compareWorld('switch back A preserves final A/B/shared', 'afterReload.final', report.snapshots.beforeReload);
    await validate('after all undo/redo', 'afterReload.final', { math: true, vocab: true, replacement: true });
    await step('final persisted histories equal pre-reload histories', async () => {
      equal(await historyDurable(), report.historyBeforeReload, 'Undo/redo round trip preserves genuine histories');
    }, { soft: true });
    report.reload.afterComplete = true;
    save();
  });
}

export function runFallback() {
  return phase('fallback', async () => {
    await step('fallback prerequisites (server restart is external)', async evidence => {
      requireThat(report.ids.A, 'Create the initial plan first; fallback can be tested independently of later model failures.');
      await mount();
      evidence({ setup: 'Caller must have restarted real function-live with invalid primary + valid backup; credentials are never inspected.' });
    });
    const before = await snapshot('fallback.before');
    const historyBefore = await historyDurable();
    const ui = await send('fallback', TEXT.fallback, 'text');
    await step('fallback transport: visible backup-model switch and successful reply', evidence => {
      const visible = renderedText(chatRegion());
      evidence({ chat: 'fallback', assistantText: ui.assistantText, statusText: ui.statusText,
        messages: ui.messages, error: ui.error, visible });
      requireThat(!ui.error && ui.assistantText.some(t => t.trim()) && ui.statusText.some(t => t.includes('切换备用模型')) &&
        visible.includes('切换备用模型'), 'Expected a visible, persisted backup switch and a completed reply without transport errors', ui);
    }, { soft: true });
    await step('fallback intent: harmless greeting must not propose mutations/questions', evidence => {
      evidence({ chat: 'fallback', delivered: ui.delivered });
      requireThat(!ui.delivered.artifact && !ui.delivered.patch && !ui.delivered.question,
        'Backup transport may have succeeded, but the model violated harmless intent by generating an artifact/question', ui);
    }, { soft: true });
    await snapshot('fallback.after');
    await compareWorld('fallback does not mutate plans/shared', 'fallback.after', before);
    await step('fallback leaves persisted histories unchanged', async () => {
      equal(await historyDurable(), historyBefore, 'Fallback history isolation');
    }, { soft: true });
  });
}
