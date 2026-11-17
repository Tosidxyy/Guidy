# M3-B 研究式规划 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给现有自由对话 agent 注入联网研究能力（WebSearch/WebFetch），用户意图模糊时先检索再给具体计划，来源融入正文，迭代复用 M3-A patch 闭环。

**Architecture:** 方案 1 最小增强——不新增子系统。Agent 定义启用最小只读工具白名单（always_allow）；系统提示词加研究指引；projector 把 `agent.tool_use` 投影为非终态 `progress` 事件并加 `requires_action` 防御守卫；前端 transient「正在联网检索…」指示。计划产物/预览/commit/patch 迭代全部复用 M2+A。

**Tech Stack:** React + Zustand + @tanstack/react-query + vitest（NODE 环境，无 jsdom，组件不做单测）；Deno Edge Function（Deno 仅 npm devDependency）；npm:zod@3.25.76；QCA SSE。

**Spec:** docs/superpowers/specs/2026-11-16-m3-b-research-planning-design.md

## Global Constraints

- QODER_PAT 平台托管：仅 Function 内 `Deno.env.get('QODER_PAT')` 读取；绝不送浏览器/记日志/列入 `prepare_site.secretNames`/经普通 Secret 工具写入；空 `get_site(secrets)` 不代表 PAT 缺失。
- Deno 仅作 npm devDependency，绝不系统级安装；本地 Deno 门禁针对平台无关的 `functions/app.ts`。
- 不发布无授权：用户已选「暂不发布」，发布当前撤回——无新明确授权（命名站点）绝不发布。本计划全部为本地代码 + 单测 + 门禁，不含任何云写/发布。
- 工具/model/system 服务端固定，绝不接受公网请求传入；progress 只投影工具名，绝不外泄 `ev.input`/URL/原始工具数据/内部思考。
- 只读工具 `always_allow` 是服务端固定策略；危险工具（Bash/Write/Edit 等）不得进白名单。
- 无通用 DB 事务 → 唯一键幂等 + version 条件更新 + 对账（本计划不改这些机制）。
- `.Guidy.qoder.site` 平台再生，working-tree ` M`，排除于所有提交，绝不手写。提交只 `git add` 明确列出的文件。
- 产物契约（constraint_set/patch）字段名/类型/枚举保持不变；`CONSTRAINT_SET_EXAMPLE` 范例不改。
- vitest NODE 环境无 jsdom：纯逻辑单测 + `check:function`/`build` 门禁 + live 浏览器（延迟）。组件改动靠 tsc/build + 代码审查验证。
- subagent 本环境禁用 → 内联顺序执行，TDD/门禁/自审标准一致。
- 门禁命令：`npx vitest run`（全量）、`npm run check:function`（deno check functions/app.ts，exit 0）、`npm run build`（tsc --noEmit + vite + function-package，exit 0）。
- TDD 铁律：先写失败测试并亲眼看它失败，再写最小实现。每个任务结束提交。

---

### Task 1: RESEARCH_TOOLS 纯模块 + live.ts 接线

**Files:**
- Create: `functions/qca/tools.ts`
- Create: `functions/__tests__/tools.test.ts`
- Modify: `functions/qca/live.ts:1`（加 import）与 `:27`（`tools: []` → `tools: RESEARCH_TOOLS`）

**Interfaces:**
- Consumes: 无（纯常量）。
- Produces: `RESEARCH_TOOLS`（命名导出，数组），供 live.ts agent 定义 `tools` 字段使用。形状见下。

- [ ] **Step 1: 写失败测试**

Create `functions/__tests__/tools.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RESEARCH_TOOLS } from '../qca/tools';
describe('RESEARCH_TOOLS — 最小只读研究工具白名单', () => {
  it('恰有一个 agent_toolset_20260401 条目', () => {
    expect(RESEARCH_TOOLS).toHaveLength(1);
    expect(RESEARCH_TOOLS[0].type).toBe('agent_toolset_20260401');
  });
  it('enabled_tools 恰为 WebSearch + WebFetch（无危险工具）', () => {
    expect(RESEARCH_TOOLS[0].enabled_tools).toEqual(['WebSearch', 'WebFetch']);
  });
  it('两者 permission_policy 均为 always_allow', () => {
    const configs = RESEARCH_TOOLS[0].configs;
    const byName = Object.fromEntries(configs.map((c: any) => [c.name, c.permission_policy.type]));
    expect(byName.WebSearch).toBe('always_allow');
    expect(byName.WebFetch).toBe('always_allow');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run functions/__tests__/tools.test.ts`
Expected: FAIL —「Cannot find module '../qca/tools'」（模块不存在）。

- [ ] **Step 3: 写最小实现**

Create `functions/qca/tools.ts`:

```ts
// 服务端固定的最小只读研究工具白名单。危险工具对模型完全不可见。
// 只读检索工具设 always_allow：平台直接执行，不暂停（Guidy 不实现工具确认回传链路）。
export const RESEARCH_TOOLS = [
  {
    type: 'agent_toolset_20260401',
    enabled_tools: ['WebSearch', 'WebFetch'],
    configs: [
      { name: 'WebSearch', permission_policy: { type: 'always_allow' } },
      { name: 'WebFetch', permission_policy: { type: 'always_allow' } },
    ],
  },
];
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run functions/__tests__/tools.test.ts`
Expected: PASS（3 个用例）。

- [ ] **Step 5: live.ts 接线**

Modify `functions/qca/live.ts`：
- 第 1 行区域加 import（与现有 import 并列）：

```ts
import { RESEARCH_TOOLS } from './tools.ts';
```

- 第 27 行 agent 定义里 `tools: []` 改为 `tools: RESEARCH_TOOLS`。改后该行形如：

```ts
          agent: { name: 'Guidy 排程助手', model, system: buildSystemPrompt(), tools: RESEARCH_TOOLS, metadata: { app: 'guidy', purpose: 'planning' } },
```

- [ ] **Step 6: 门禁验证接线**

Run: `npm run check:function`
Expected: exit 0（deno check 通过，live.ts 引用 RESEARCH_TOOLS 类型正确）。

- [ ] **Step 7: 提交**

```bash
git add functions/qca/tools.ts functions/__tests__/tools.test.ts functions/qca/live.ts
git commit -m "feat(m3-b): enable minimal read-only research tools on the planning agent"
```

---

### Task 2: 系统提示词研究式规划指引

**Files:**
- Modify: `functions/prompt.ts`（`buildSystemPrompt`，在对话策略块之后、`【constraint_set 契约】` 之前插入研究指引）
- Modify: `functions/__tests__/artifacts.test.ts`（追加一个 describe 块）

**Interfaces:**
- Consumes: 既有 `buildSystemPrompt(): string`。
- Produces: `buildSystemPrompt()` 返回值含研究指引关键词；constraint_set/patch 契约与范例不变。

- [ ] **Step 1: 写失败测试**

在 `functions/__tests__/artifacts.test.ts` 末尾追加：

```ts
describe('prompt 研究式规划指引 — 用户不知道做什么时联网检索', () => {
  it('声明研究式规划并点名 WebSearch/WebFetch', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('研究式规划');
    expect(p).toContain('WebSearch');
    expect(p).toContain('WebFetch');
  });
  it('要求把来源依据写进正文，不暴露原始搜索词', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('来源');
    expect(p).toContain('不要暴露原始搜索词');
  });
  it('检索无果回退自身知识，适度搜索不拖延', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('回退自身知识');
    expect(p).toContain('不要过度搜索');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run functions/__tests__/artifacts.test.ts`
Expected: FAIL — 新 describe 三个用例失败（prompt 不含这些词）；既有用例仍 PASS。

- [ ] **Step 3: 写最小实现**

Modify `functions/prompt.ts` `buildSystemPrompt`：在对话策略块最后一行 `'- 结构化产物一旦输出，字段名、类型、枚举必须与下方契约逐字一致，不要自创字段、不要改用近义词或把对象写成字符串。',` 之后、空行 `''` 与 `'【constraint_set 契约】'` 之前，插入以下行（保持数组元素逗号语法）：

```ts
    '',
    '【研究式规划——用户不知道做什么时】',
    '- 用户无明确目标、意图模糊或不确定做什么时，可先用 WebSearch/WebFetch 检索权威资料（官方大纲、公认方法论等），结合自身知识理解需求。',
    '- 检索是为了给出更具体、有依据的计划；信息足够后仍按下方契约输出 constraint_set，或先自然语言追问。',
    '- 把关键依据（来源名称/出处）写进产物前后的自然语言正文，让用户知道计划从何而来；不要暴露原始搜索词或工具细节。',
    '- 检索不到权威资料时回退自身知识并追问，不臆造用户未给出的硬性时间；适度检索，不要过度搜索拖延回答。',
```

注意：不要改动 `CONSTRAINT_SET_EXAMPLE`、constraint_set/patch 契约文本、既有对话策略行。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run functions/__tests__/artifacts.test.ts`
Expected: PASS（新 3 用例 + 全部既有用例，含范例可解析、契约关键词锁定）。

- [ ] **Step 5: 门禁**

Run: `npm run check:function`
Expected: exit 0。

- [ ] **Step 6: 提交**

```bash
git add functions/prompt.ts functions/__tests__/artifacts.test.ts
git commit -m "feat(m3-b): add research-backed planning guidance to the system prompt"
```

---

### Task 3: AppEvent progress 类型 + projector 投影与 requires_action 守卫

**Files:**
- Modify: `functions/types.ts:18-24`（AppEvent 联合加 progress 支）
- Modify: `functions/qca/project.ts`（加 agent.tool_use 分支 + session 分支 requires_action 守卫）
- Modify: `functions/__tests__/project.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: `createProjector(seq: () => number, deltaSeq: number)`；`AppEvent`（types.ts）。
- Produces: AppEvent 新增 `{ event: 'progress'; data: { seq: number; tool: 'WebSearch' | 'WebFetch' } }`；projector 对 WebSearch/WebFetch 的 `agent.tool_use` 发 progress（seq=deltaSeq，仅工具名）；对 `stop_reason.type==='requires_action'` 发 error（code `tool_confirmation_unsupported`）而非 completed。

- [ ] **Step 1: 写失败测试**

在 `functions/__tests__/project.test.ts` 末尾追加：

```ts
describe('projector — 研究工具事件投影', () => {
  it('agent.tool_use(WebSearch) → progress，仅工具名，不泄露 input，非终态', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    const out = p.push({ type: 'agent.tool_use', id: 'evt_t', name: 'WebSearch', input: { query: '秘密搜索词' }, evaluated_permission: 'allow' });
    expect(out[0]).toMatchObject({ event: 'progress', data: { seq: DELTA_SEQ, tool: 'WebSearch' } });
    expect(JSON.stringify(out)).not.toContain('秘密搜索词');
    expect(p.isTerminal()).toBe(false);
  });
  it('agent.tool_use(WebFetch) → progress', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    const out = p.push({ type: 'agent.tool_use', id: 'evt_t', name: 'WebFetch', input: { url: 'https://x' } });
    expect(out[0]).toMatchObject({ event: 'progress', data: { tool: 'WebFetch' } });
  });
  it('白名单外工具名忽略', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    expect(p.push({ type: 'agent.tool_use', id: 'evt_t', name: 'Bash', input: {} })).toHaveLength(0);
  });
  it('requires_action → error 而非 completed（终态 failed）', () => {
    const p = createProjector(seqFactory(), DELTA_SEQ);
    const out = p.push({ type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['evt_t'] } });
    expect(out[0]).toMatchObject({ event: 'error', data: { code: 'tool_confirmation_unsupported' } });
    expect(p.isTerminal()).toBe(true);
    expect(out.some((e) => e.event === 'status')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run functions/__tests__/project.test.ts`
Expected: FAIL — progress 用例 `out[0]` 为 undefined（projector 不处理 agent.tool_use）；requires_action 用例当前被当 completed（断言 error 失败）。既有用例仍 PASS。

- [ ] **Step 3: 写最小实现 — types.ts**

Modify `functions/types.ts` AppEvent 联合（在 `status` 支之后、`error` 支之前加一行）：

```ts
  | { event: 'progress'; data: { seq: number; tool: 'WebSearch' | 'WebFetch' } }
```

- [ ] **Step 4: 写最小实现 — project.ts**

Modify `functions/qca/project.ts`：

(a) 在 `agent.message` 分支之后、`session` 分支之前，插入新分支：

```ts
      } else if (type === 'agent.tool_use') {
        const name: string = ev.name ?? '';
        if (name === 'WebSearch' || name === 'WebFetch') {
          out.push({ event: 'progress', data: { seq: deltaSeq, tool: name as 'WebSearch' | 'WebFetch' } });
        }
```

(b) 在 `session` 分支内，`failedNow`/`idleNow`/`endedNow` 计算之后、`if (failedNow)` 之前，加 requires_action 判定，并把它插到 failedNow 与 idleNow 之间：

```ts
        const requiresAction = ev.stop_reason?.type === 'requires_action';
        if (failedNow) {
          terminal = true; failed = true;
          out.push({ event: 'error', data: { seq: seq(), code: 'upstream_error', message: 'AI 服务暂时不可用', diagnostic_id: crypto.randomUUID() } });
        } else if (requiresAction) {
          terminal = true; failed = true;
          out.push({ event: 'error', data: { seq: seq(), code: 'tool_confirmation_unsupported', message: 'AI 需要工具确认，暂不支持', diagnostic_id: crypto.randomUUID() } });
        } else if (idleNow || endedNow) {
          terminal = true;
          out.push({ event: 'status', data: { seq: seq(), state: failed ? 'failed' : 'completed' } });
        }
```

（即用上面这段替换原 `if (failedNow) {...} else if (idleNow || endedNow) {...}` 整段；其余不动。）

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run functions/__tests__/project.test.ts`
Expected: PASS（新 4 用例 + 全部既有 projector 用例）。

- [ ] **Step 6: 门禁**

Run: `npm run check:function`
Expected: exit 0（progress 已进 AppEvent 联合，project.ts 类型正确）。

- [ ] **Step 7: 提交**

```bash
git add functions/types.ts functions/qca/project.ts functions/__tests__/project.test.ts
git commit -m "feat(m3-b): project tool_use to transient progress and guard requires_action"
```

---

### Task 4: chat.ts progress 旁路（不持久化、不进 collected）

**Files:**
- Modify: `functions/routes/chat.ts:75-80`（push 循环内对 progress 单独 emit 后 continue）
- Modify: `functions/__tests__/chat.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 3 的 projector（发 progress）；`createFakeQca`/`upstreamStream`（dev/fake-qca）；`application`（functions/app）；`rows`（functions/db）。
- Produces: chatSend 实时流含 progress 事件；progress 不写入 messages 表、不进 dispatch result（collected）；terminalState 不受 progress 影响。

**TDD 说明**：Task 3 后 projector 已发 progress，chat.ts 现有循环 `emit(p); collected.push(p)` 会 emit progress 且不匹配持久化分支——故「progress 被 emit/不持久化」在 Task 3 后已成立。本任务的**真正新增行为**是把 progress 排除出 `collected`（不参与重放）。因此 RED 驱动测试是「重放不含 progress」，它在修改前必然失败（collected 含 progress → 重放重发）。

- [ ] **Step 1: 写失败测试（RED 驱动：重放排除）**

在 `functions/__tests__/chat.test.ts` 的 `describe('chatSend', ...)` 块内追加：

```ts
  it('progress 不进 collected：重复 request_id 重放不含 progress', async () => {
    const frames = [
      { type: 'agent.tool_use', id: 'evt_t', name: 'WebSearch', input: {} },
      { type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '好的' }] },
      { type: 'session.status_idle' },
    ];
    const d = deps({ openStream: async () => ({ body: upstreamStream(frames), close() {} }) });
    const app = application(d);
    const body = { text: '不知道做什么', request_id: 'req-prog' };
    const first = await collect(await app(ctx('POST', '/api/chat/send', body)));
    expect(first.some((f) => f.event === 'progress')).toBe(true);
    const second = await collect(await app(ctx('POST', '/api/chat/send', body)));
    expect(second.some((f) => f.event === 'progress')).toBe(false);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run functions/__tests__/chat.test.ts`
Expected: FAIL — 末行断言失败：第二次（重放）`second.some(progress)` 为 true（collected 当前含 progress，重放重发）。亲眼看到该失败。

- [ ] **Step 3: 写最小实现**

Modify `functions/routes/chat.ts` push 循环（约 75-80 行）。当前形如：

```ts
              for (const p of projector.push(ev)) {
                emit(p); collected.push(p);
                if (p.event === 'delta') await appendAssistant(deps.db, conv, p.data.seq, p.data.text);
                if (p.event === 'status') { terminalState = p.data.state === 'completed' ? 'completed' : 'failed'; await insertMessage(deps.db, conv, { seq: p.data.seq, role: 'system', kind: 'status', content: p.data.state }); }
                if (p.event === 'error') { terminalState = 'failed'; await insertMessage(deps.db, conv, { seq: p.data.seq, role: 'system', kind: 'error', content: p.data.code }); }
              }
```

改为（progress 单独 emit 后 continue，跳过 collected 与持久化）：

```ts
              for (const p of projector.push(ev)) {
                if (p.event === 'progress') { emit(p); continue; }
                emit(p); collected.push(p);
                if (p.event === 'delta') await appendAssistant(deps.db, conv, p.data.seq, p.data.text);
                if (p.event === 'status') { terminalState = p.data.state === 'completed' ? 'completed' : 'failed'; await insertMessage(deps.db, conv, { seq: p.data.seq, role: 'system', kind: 'status', content: p.data.state }); }
                if (p.event === 'error') { terminalState = 'failed'; await insertMessage(deps.db, conv, { seq: p.data.seq, role: 'system', kind: 'error', content: p.data.code }); }
              }
```

- [ ] **Step 4: 追加支撑测试（emit + 不持久化 + 不泄露 input + 终态）**

同 describe 内追加（这些在 Task 3 后多已成立，作为回归护栏）：

```ts
  it('progress：实时流含 progress（仅工具名、不泄露 input），不持久化为消息，终态 completed', async () => {
    const frames = [
      { type: 'agent.tool_use', id: 'evt_t', name: 'WebSearch', input: { query: '秘密搜索词' }, evaluated_permission: 'allow' },
      { type: 'event_delta', event_id: 'e1', delta: { type: 'content_delta', content: { type: 'text', text: '好的' } } },
      { type: 'agent.message', id: 'e1', content: [{ type: 'text', text: '好的' }] },
      { type: 'session.status_idle' },
    ];
    const d = deps({ openStream: async () => ({ body: upstreamStream(frames), close() {} }) });
    const out = await collect(await application(d)(ctx('POST', '/api/chat/send', { text: '不知道做什么' })));
    const prog = out.find((f) => f.event === 'progress');
    expect(prog?.data.tool).toBe('WebSearch');
    expect(JSON.stringify(out)).not.toContain('秘密搜索词');
    expect(out.some((f) => f.event === 'status' && f.data.state === 'completed')).toBe(true);
    const { rows } = await import('../db');
    const msgs = rows(await d.db.from('messages').select('*'));
    expect(msgs.some((m: any) => m.kind === 'progress' || m.content === 'WebSearch')).toBe(false);
  });
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run functions/__tests__/chat.test.ts`
Expected: PASS（重放排除用例转绿 + 支撑用例 + 全部既有 chat 用例）。

- [ ] **Step 6: 门禁**

Run: `npm run check:function`
Expected: exit 0。

- [ ] **Step 7: 提交**

```bash
git add functions/routes/chat.ts functions/__tests__/chat.test.ts
git commit -m "feat(m3-b): emit progress as a transient side-channel, excluded from persistence and replay"
```

---

### Task 5: 前端 searching 状态 + reduceFrame

**Files:**
- Modify: `store/useChatStore.ts`（ChatState 加 searching；initialChatState；reduceFrame 各 case；startSend）
- Modify: `store/__tests__/chatStore.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: Task 3 的 progress 事件形状 `{ event:'progress', data:{ seq, tool } }`。
- Produces: `ChatState.searching: boolean`；reduceFrame 对 progress 置 searching=true（不进 messages），delta/终态 status/done/error/accepted 复位 false；startSend 复位 false。

- [ ] **Step 1: 写失败测试**

在 `store/__tests__/chatStore.test.ts` 末尾追加：

```ts
describe('reduceFrame — progress 研究指示', () => {
  it('progress 置 searching=true 且不进 messages', () => {
    const s = reduceFrame(initialChatState, { event: 'progress', data: { seq: 7, tool: 'WebSearch' } });
    expect(s.searching).toBe(true);
    expect(s.messages).toHaveLength(0);
  });
  it('首个 delta 清除 searching', () => {
    let s = reduceFrame(initialChatState, { event: 'progress', data: { seq: 7, tool: 'WebSearch' } });
    s = reduceFrame(s, { event: 'delta', data: { seq: 7, text: '好' } });
    expect(s.searching).toBe(false);
  });
  it('终态 status/done/error 复位 searching', () => {
    const base = { ...initialChatState, searching: true };
    expect(reduceFrame(base, { event: 'status', data: { seq: 8, state: 'completed' } }).searching).toBe(false);
    expect(reduceFrame(base, { event: 'done', data: { seq: 8 } }).searching).toBe(false);
    expect(reduceFrame(base, { event: 'error', data: { seq: 8, code: 'x', message: 'm', diagnostic_id: 'd' } }).searching).toBe(false);
  });
  it('accepted 复位 searching', () => {
    const base = { ...initialChatState, searching: true };
    const s = reduceFrame(base, { event: 'accepted', data: { request_id: 'r', conversation_id: 'c', seq: 1 } });
    expect(s.searching).toBe(false);
  });
  it('startSend 复位 searching', () => {
    useChatStore.setState({ searching: true });
    useChatStore.getState().startSend('hi');
    expect(useChatStore.getState().searching).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run store/__tests__/chatStore.test.ts`
Expected: FAIL — `searching` 字段不存在（undefined），新用例失败；既有用例仍 PASS。

- [ ] **Step 3: 写最小实现**

Modify `store/useChatStore.ts`：

(a) `ChatState` 接口加字段（在 `restoreDone: boolean;` 之前或之后）：

```ts
  searching: boolean;
```

(b) `initialChatState` 加 `searching: false`（在 `restoreDone: false` 旁）：

```ts
export const initialChatState: ChatState = { conversationId: null, requestId: null, messages: [], streaming: false, connection: 'idle', cursor: '0:0', artifact: null, patch: null, clarifications: [], error: null, searching: false, restoreDone: false };
```

(c) `reduceFrame`：
- `case 'accepted'` 返回对象加 `searching: false`。
- `case 'delta'` 返回对象加 `searching: false`。
- 在 `case 'artifact'` 之后、`case 'status'` 之前加：

```ts
    case 'progress':
      return { ...state, searching: true };
```

- `case 'status'` 改为：

```ts
    case 'status':
      return { ...state, streaming: !TERMINAL.includes(d.state), connection: TERMINAL.includes(d.state) ? 'idle' : state.connection, searching: TERMINAL.includes(d.state) ? false : state.searching };
```

- `case 'error'` 返回对象加 `searching: false`。
- `case 'done'` 返回对象加 `searching: false`。

(d) `startSend` 的 set 对象加 `searching: false`：

```ts
  startSend: (text) => set({ ...get(), streaming: true, connection: 'connecting', error: null, artifact: null, patch: null, clarifications: [], searching: false, restoreDone: true, messages: [...get().messages, { seq: -1, role: 'user', kind: 'text', content: text }] }),
```

（`setConversation`/`reset` 已 spread `initialChatState`，自动含 searching:false，无需改。）

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run store/__tests__/chatStore.test.ts`
Expected: PASS（新 5 用例 + 全部既有 chatStore 用例）。

- [ ] **Step 5: 门禁**

Run: `npm run build`
Expected: exit 0（tsc --noEmit 通过，ChatState.searching 类型正确）。

- [ ] **Step 6: 提交**

```bash
git add store/useChatStore.ts store/__tests__/chatStore.test.ts
git commit -m "feat(m3-b): track transient searching state in the chat store"
```

---

### Task 6: ChatPanel transient 指示 + 全量门禁

**Files:**
- Modify: `components/chat/ChatPanel.tsx`（加 searching selector + 指示渲染）

**Interfaces:**
- Consumes: Task 5 的 `useChatStore` `searching` 字段、`streaming` 字段。
- Produces: `searching && streaming` 时渲染「正在联网检索…」transient 文本；正文开始（searching=false）即消失。无新增持久消息/来源卡片。

- [ ] **Step 1: 加 selector**

Modify `components/chat/ChatPanel.tsx`：在 `const streaming = useChatStore((s) => s.streaming);`（约 20 行）之后加：

```ts
  const searching = useChatStore((s) => s.searching);
```

- [ ] **Step 2: 渲染指示**

在 `{connection === 'connecting' && <p className="px-1 text-[11px] text-site-ink-soft">正在连接…</p>}`（约 134 行）之后加：

```tsx
        {searching && streaming && <p className="px-1 text-[11px] text-site-ink-soft">正在联网检索…</p>}
```

- [ ] **Step 3: 门禁（组件无单测，靠 tsc/build + 代码审查）**

Run: `npm run build`
Expected: exit 0（tsc --noEmit + vite + function-package 全通过）。

- [ ] **Step 4: 全量门禁（跨任务回归确认）**

Run: `npx vitest run`
Expected: 全部 PASS（含 A 的 169 用例 + B 新增用例，0 失败）。

Run: `npm run check:function`
Expected: exit 0。

Run: `npm run build`
Expected: exit 0。

- [ ] **Step 5: 提交**

```bash
git add components/chat/ChatPanel.tsx
git commit -m "feat(m3-b): show a transient searching indicator during research turns"
```

---

## 集成验证（任务完成后，控制器执行）

全链路静态走查（代码级，对照 spec §5/§8）：
1. live.ts agent 定义 `tools: RESEARCH_TOOLS`（Task 1）→ 新指纹 → 首次使用新 agent 代。
2. buildSystemPrompt 含研究指引（Task 2）→ agent 知道何时检索、来源写正文。
3. projector：agent.tool_use(WebSearch/WebFetch) → progress（Task 3）；requires_action → error。
4. chat.ts：progress emit 但跳过 collected/持久化（Task 4）→ 重放不含 progress。
5. reduceFrame：progress → searching；delta/终态复位（Task 5）。
6. ChatPanel：searching && streaming → 「正在联网检索…」（Task 6）。
7. 产物/预览/commit/patch 迭代链路未改 → 复用 M2+A。

**live 真实 AI 验收（延迟）**：需用户新明确授权命名站点发布后执行（spec §8.8/8.9）：模糊意图 → 正在联网检索… → 含来源计划 → 确认应用 → patch 迭代。本计划不含发布。

## Self-Review 记录

- **Spec 覆盖**：§4.1 tools→Task1；§4.2 prompt→Task2；§4.3 AppEvent + §4.4 projector→Task3；§4.5 chat.ts→Task4；§4.6 store→Task5；§4.7 ChatPanel→Task6；§4.8 来源（零改动，agent 正文）→Task2 指引覆盖；§4.9 sse.ts 无需改；§6 requires_action→Task3，工具失败/降级→Task2 指引 + 既有路径；§7 测试→各任务 TDD + Task6 全量门禁；§8 验收 1-7 代码级各任务覆盖，8-9 live 延迟。无遗漏。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码块。Task4 Step2 含「观察实际失败点」说明——因 Task3 后 progress 已被 emit/不持久化，RED 可能部分满足，故 Step4 追加重放用例真正验证 collected 排除（这是该任务的核心新增行为）。
- **类型一致**：`RESEARCH_TOOLS`（Task1 定义，live.ts 消费）；`progress` data `{seq, tool:'WebSearch'|'WebFetch'}`（Task3 types 定义，projector 产出，Task4 chat 消费，Task5 reduceFrame 消费）；`searching: boolean`（Task5 定义，Task6 消费）；`tool_confirmation_unsupported`（Task3 projector 产出，既有 error 路径消费）。命名跨任务一致。