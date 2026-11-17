# M3-B 研究式规划（Research-Backed Planning）设计

**状态**：设计已逐节获批（Q1–Q4 全选 A，方案 1 最小增强），待用户审阅本 spec。
**日期**：2026-11-16
**依赖**：M2（自由对话 → constraint_set → 预览 → commit）已完成并私有部署；M3-A（AI patch 编辑闭环）已完成（分支 Guidy-Qoder）。B 的迭代细化直接复用 A。
**前置 spike**：R1 已验证 QCA 联网检索可用（无需降级）。

## 1. 目标与范围

**需求（用户原话）**：「如果用户完全不知道做什么，这个时候 agent 需要结合自己的知识并且上网搜索，再给出具体计划，通过用户后续追加再慢慢修改计划，这个加入 M3 一起实现吧。」

**目标**：给现有自由对话 agent 注入联网研究能力。用户意图模糊/无计划时，agent 自主决定先用 WebSearch/WebFetch 检索权威资料，结合自身知识 eliciting 需求或生成具体计划；关键依据融入计划正文；后续追加修改走 A 的 patch 闭环。

**范围内**：
- Agent 定义启用最小只读工具白名单（WebSearch + WebFetch，均 always_allow）。
- 系统提示词新增研究式规划指引。
- projector 投影 `agent.tool_use` 为非终态 `progress` 事件；`requires_action` 防御守卫。
- 前端 transient「正在联网检索…」指示。
- 来源融入助手自然语言正文（零 schema 改动）。

**范围外（YAGNI）**：
- 不新增独立研究 agent/binding/端点/模式入口（Q1=A：同一 agent 自主判断）。
- 不新增独立来源卡片 UI（Q2=A：来源融入正文）。
- 不实现工具确认回传链路（Q4=A：只读工具 always_allow，无需逐次确认）。
- 不改计划产物形状、预览、commit、patch 迭代链路（全部复用 M2+A）。
- 不改每轮配额（F 子项目另管）。
- 不发布（当前发布授权已撤回；live 验收待新授权）。

## 2. R1 spike 结论（事实依据）

来源：QCA 官方文档 create-agent / tools / permission-policies（2026-11 核对）。

- **联网检索可用**：内置工具集 `agent_toolset_20260401` 原生支持 `WebSearch`（联网搜索）、`WebFetch`（HTTP GET 单页）。工具名须精确写法，未知名称返回 400。
- **最小白名单**：`enabled_tools` 为非空白名单时，列表外工具对模型**完全不可见**，不会发生调用尝试。`enabled_tools` 省略/空数组等同启用全部内置工具（含 Bash/Write/DeliverArtifacts 等）——故必须显式列白名单。整个 `tools` 省略或 `[]` 则不启用任何工具（当前状态）。
- **权限策略**：内置工具经 `tools[].configs[].permission_policy` 评为 allow/ask/deny。
  - `always_allow` → `evaluated_permission:"allow"` → 平台直接执行，不暂停。
  - `always_ask` → `evaluated_permission:"ask"` → 当前 turn 暂停，发 `session.status_idle` 且 `stop_reason.type:"requires_action"`，等 `user.tool_confirmation`；**pending action 永不自动超时**。
  - `always_deny` → 平台向 agent 返回被拒绝的工具结果。
- **工具事件投影**：`agent.tool_use`（字段 `id`, `name`, `input`, `evaluated_permission`）；MCP 为 `agent.mcp_tool_use`；client-side 自定义为 `agent.custom_tool_use`（始终暂停，由应用执行回传，与本设计无关）。
- **工具绑定 Agent**：工具配置绑定在 Agent 上，同一 Agent 所有 Session 共享，Session 级不可覆盖。更新 tools 须带 version 乐观并发；已有 Session 不受影响，新 Session 用新配置。
- **Guidy 现状**：`functions/qca/live.ts:27` agent 定义 `tools: []`；`ensureCloudResources` 对定义做规范化指纹（`qsites_config` metadata），改 tools/system → 新指纹 → 创建新 agent 代；已有会话保留旧资源/版本映射（initialization.md:76）。
- **安全约束**（api.md:45 / SKILL.md:20）：选最小合适工具集 + 固定服务端配置；工具/model/system 绝不接受公网请求传入；只发布应用选定的内容，不 relay 原始 prompt/工具 input/内部思考/凭证；不自动批准工具动作，除非应用实现了授权与结果回传路径。本设计对只读检索工具设服务端固定 `always_allow` 策略（危险工具对模型不可见），非运行时盲目放行。

## 3. 架构（方案 1：最小增强）

不新增子系统，给现有「自由对话 → 生成计划 → 预览应用 → patch 迭代」链路注入联网研究能力。四处改动：

1. **Agent 定义**（`functions/qca/live.ts`）：`tools: []` → `RESEARCH_TOOLS`（见 §4）。tools 与 system 同改 → 指纹变 → 首次授权使用时 `ensureCloudResources` 创建一个新 agent 代（环境复用）；已有会话保留旧映射（无工具），新会话获得研究能力。属正常初始化流程内的云资源变更，非破坏性。
2. **系统提示词**（`functions/prompt.ts` `buildSystemPrompt`）：新增研究式规划指引（见 §4）。constraint_set/patch 产物契约保持不变。
3. **Projector**（`functions/qca/project.ts`）：新增 `agent.tool_use` → 非终态 `progress` 分支；`requires_action` 防御守卫（见 §4、§6）。
4. **前端**：AppEvent 加 `progress`；ChatState 加 `searching`；reduceFrame 处理；ChatPanel transient 指示（见 §4）。

计划产物、预览、`/plans/commit`、`/patches/apply`、A 的 patch 迭代全部原样复用。

## 4. 组件与接口契约

### 4.1 工具配置（新纯模块 `functions/qca/tools.ts`）

导出常量 `RESEARCH_TOOLS`，供 live.ts 引用，便于单测：

```ts
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

live.ts agent 定义：`agent: { name: 'Guidy 排程助手', model, system: buildSystemPrompt(), tools: RESEARCH_TOOLS, metadata: { app: 'guidy', purpose: 'planning' } }`。

### 4.2 系统提示词研究指引（`buildSystemPrompt`）

在对话策略中新增研究式规划指引（措辞可在实现时微调，语义须含）：
- 用户无明确目标、意图模糊、或不确定做什么时，可先用 WebSearch/WebFetch 检索权威资料（如官方大纲、公认方法论），结合自身知识理解需求。
- 检索是为了给出更具体、有依据的计划；信息足够后仍按既有契约输出 constraint_set（或先自然语言追问）。
- 把关键依据（来源名称/出处）写进产物前后的自然语言正文，让用户知道计划从何而来；不暴露原始搜索词或工具细节。
- 不臆造用户未给出的硬性时间；检索不到权威资料时回退自身知识并自然语言追问。
- 适度检索（几次有针对性的搜索即可），不要过度搜索拖延回答。
- 产物字段名/类型/枚举仍与既有契约逐字一致。

constraint_set/patch 契约文本与 `CONSTRAINT_SET_EXAMPLE` 范例保持不变（范例仅示范字段形状，内容须来自用户实际目标）。

### 4.3 AppEvent（`functions/types.ts`）

新增一支：

```ts
| { event: 'progress'; data: { seq: number; tool: 'WebSearch' | 'WebFetch' } }
```

### 4.4 Projector（`functions/qca/project.ts`）

- 新增分支：`type === 'agent.tool_use'` 且 `ev.name ∈ {'WebSearch','WebFetch'}` → `out.push({ event:'progress', data:{ seq: deltaSeq, tool: ev.name } })`。**只取 `ev.name`，绝不读 `ev.input`**；非终态，不动 `terminal`/`failed`。其它工具名（含 MCP）忽略。用 `deltaSeq`（助手消息 seq）而非 `seq()`：progress 是关于待生成助手消息的 transient 提示，不消耗额外序号、不在持久化 seq 中留空洞。
- `requires_action` 防御守卫：在 `session.*` 分支中，若 `ev.stop_reason?.type === 'requires_action'` → `terminal=true; failed=true;` 发 `error`（code `tool_confirmation_unsupported`，message「AI 需要工具确认，暂不支持」，diagnostic_id 随机），**而非** `completed`。
- 既有 `event_delta`/`agent.message`/`session.*` 终态逻辑不变。

### 4.5 chat.ts（`functions/routes/chat.ts`）

- push 循环中：`progress` 事件只 `emit` 到实时流，**不 `insertMessage`、不进 `collected`**（transient 指示，非会话内容，不参与重放/持久化）；`terminalState` 不受影响。
- 实现方式：在循环内对 `p.event === 'progress'` 单独 `emit(p)` 后 `continue`（跳过 collected.push 与持久化分支）。
- `chatEvents`（resume）重放持久化消息；progress 未持久化故不会在此重放——searching 指示仅 live 出现。

### 4.6 前端 ChatState / reduceFrame（`store/useChatStore.ts`）

- `ChatState` 加 `searching: boolean`；`initialChatState.searching = false`。
- `reduceFrame`：
  - `case 'progress': return { ...state, searching: true }`（不 push messages）。
  - `case 'delta'`：返回时 `searching: false`（首个正文到达即清除）。
  - `case 'accepted'`：`searching: false`。
  - `case 'status'`：终态时 `searching: false`（非终态保持）。
  - `case 'error'` / `case 'done'`：`searching: false`。
- `startSend` / `setConversation` / `reset`：`searching: false`。

### 4.7 ChatPanel（`components/chat/ChatPanel.tsx`）

- `searching && streaming` 时显示 transient「正在联网检索…」指示（轻量文本/ spinner，dawn-gradient 风格一致），正文开始即消失。
- 不新增持久消息、不新增来源卡片。

### 4.8 来源呈现（Q2=A）

agent 把依据写进 constraint_set 围栏块前后的自然语言正文。`parseModelText`（`functions/artifacts.ts`）优先匹配 ```json 围栏块解析产物，正文不干扰解析；正文随 delta 流式输出并持久化为助手 text 消息。零 schema 改动。

### 4.9 lib/sse.ts

无需改：progress 非 done/error，流继续。

## 5. 数据流

一次「用户完全不知道做什么」的研究式规划回合：

1. **发送**：模糊意图 → `chatSend` → `requireVisitor` → 配额校验 → `ensureConversation` → `beginDispatch`（幂等 intent）→ `loadPlanState`（无 plan → null）。
2. **建会话**：`ensureQcaSession` → `ensureBinding`。首次新 tools+system 指纹 → `ensureCloudResources` 创建新 agent 代（环境复用）→ `createSession` → 记录 Cloud Session ID。
3. **投递**：`buildUserMessage`（注入「当前还没有计划。」+ 用户消息）→ `openStream`（仅 agent.message deltas）→ `sendEvents`。
4. **研究阶段**：agent 自主搜索 → 平台发 `agent.tool_use`(WebSearch) → projector 投影 `progress` → 前端「正在联网检索…」→ 平台 always_allow 直接执行（不暂停）→ 可能多次 WebSearch/WebFetch。
5. **生成阶段**：agent 综合知识 + 检索结果 → 流式正文（含来源）+ ```json constraint_set``` → projector `delta`（前端清 searching、累积正文）→ `session.status_idle` → 终态 `status:completed`。
6. **产物**：`parseModelText` 解析围栏 JSON → `artifact` → ConstraintConfirmCard（来源已在正文消息）。
7. **应用**：确认 → 既有预览 → `/plans/commit`（M2）→ 落库。
8. **迭代**：后续追加 → agent 输出 `patch` → A 闭环（PatchConfirmCard → previewPatch → PreviewDiffCard → `/patches/apply` → version+1 → 快照撤销）。

**关键不变量**：研究只增强 agent 知识输入；产物形状/预览/应用/迭代与 M2+A 一致；progress 是旁路 transient 指示，不进入持久化/重放/终态判定。

## 6. 错误处理

- **requires_action 防御**：见 §4.4。Guidy 不实现确认回传链路，宁可显式报错（`tool_confirmation_unsupported`）也不静默挂死/假完成。
- **工具执行失败**：WebSearch/WebFetch 上游失败由平台返回错误工具结果，agent 自行降级（模型知识 + 追问）；projector 不视 `agent.tool_use` 为终态。仅 `session.error`/failed 走既有 `upstream_error`。
- **搜索无果**：非错误。提示词指引回退自身知识并追问，不臆造。
- **Agent 换代失败**：`ensureCloudResources` 的 202 pending / 409 conflict / repair 既有处理复用；多匹配 → `ai_initialization_conflict`，不任意选/不自动删。
- **延迟**：研究回合更长。`openStream` 15s 超时只覆盖响应头，流生命周期归应用；受 Sites Function 时长上限约束，超限走既有 `upstream_error`。不新增超时逻辑。
- **配额**：B 不改每轮配额（F 另管）；研究多耗 token 仍按轮计。
- **凭证/数据边界**：progress 仅工具名；PAT 仍 Function-only（`Deno.env.get('QODER_PAT')`）；绝不外泄 input/URL/原始工具数据/内部思考。

## 7. 测试

vitest（NODE 环境，无 jsdom）→ 纯逻辑单测 + 门禁 + live 浏览器实测。TDD 先红后绿。

- **projector**：`agent.tool_use`(WebSearch/WebFetch) → progress 且 data 只含 tool 名（断言不含 input）；未知工具名忽略；`requires_action` → error 而非 completed；progress 非终态；既有 delta/status/终态用例不回归。
- **tools 配置**：`RESEARCH_TOOLS` 断言 type==='agent_toolset_20260401'、enabled_tools 恰为 ['WebSearch','WebFetch']、两者 configs.permission_policy.type==='always_allow'。
- **prompt**：`buildSystemPrompt()` 含研究指引关键词；constraint_set/patch 契约与范例仍可被 `parseModelText` 解析（既有契约测试不回归）。
- **reduceFrame**：progress → searching:true 且不进 messages；首个 delta → searching:false；accepted/终态 status/done/error → 复位；既有事件用例不回归。
- **门禁**：`npx vitest run` 全绿 + `npm run check:function`（deno check functions/app.ts）exit 0 + `npm run build`（tsc --noEmit + vite + function-package）exit 0。
- **live 真实 AI 验收**（延迟，需新发布授权）：见 §8。fixture 不产生真实搜索。

## 8. 验收标准

代码级（门禁 + 单测可验）：
1. `RESEARCH_TOOLS` 形状正确（最小白名单 + always_allow），live.ts 引用它。
2. projector 对 WebSearch/WebFetch tool_use 投影 progress（仅工具名）；未知工具忽略；requires_action → error 非 completed。
3. reduceFrame progress→searching、delta/终态复位、不进 messages。
4. buildSystemPrompt 含研究指引；既有 constraint_set/patch 契约与范例仍可解析。
5. chat.ts progress 不持久化、不进 collected、不影响 terminalState。
6. 门禁全绿（vitest + check:function + build）。
7. 零凭证/原始工具数据外泄（progress 仅工具名；PAT Function-only）。

live 级（延迟，需新发布授权命名站点）：
8. 模糊意图（如「我想提升自己但不知道做什么」）→ 出现「正在联网检索…」→ 生成含来源依据的具体计划 → 确认应用 → 后续追加走 patch 迭代（version+1 + 撤销）。
9. 研究回合无假完成/挂死；搜索失败时优雅降级。

## 9. 安全与平台约束（继承，逐条生效）

- QODER_PAT 平台托管：仅 Function 内 `Deno.env.get('QODER_PAT')` 读取；绝不送浏览器/记日志/列入 `prepare_site.secretNames`/经普通 Secret 工具写入；空 `get_site(secrets)` 不代表 PAT 缺失。
- Deno 仅作 npm devDependency，绝不系统级安装；本地 Deno 门禁针对平台无关的 functions/app.ts。
- Sites 写用稳定 UUID requestId；未知结果保留 refs/params 先诊断再重试，绝不盲目重写/自动创建替代 PAT。
- 不发布无授权：既往发布授权不延及新变更；用户已选「暂不发布」，发布当前**撤回**——无新明确授权（命名站点）绝不发布。
- 无通用 DB 事务 → 唯一键幂等 + version 条件更新 + 对账。
- M2 保持私有（public=M4）；验收不用 mock 冒充真实 AI/持久化。
- 云写/merge/push 需用户明确确认。
- `.Guidy.qoder.site` 平台再生，working-tree ` M`，排除于所有提交，绝不手写。
- QCA：工具/model/system 服务端固定，绝不接受公网请求传入；不 relay 原始 prompt/工具 input/内部思考；只读工具 always_allow 是服务端固定策略，非运行时盲目放行。
- subagent 在本环境禁用 → 内联顺序执行，TDD/门禁/自审标准一致；独立 subagent 评审未执行（记录在案）。

## 10. 延迟项与后续

- **发布 + live 验收**：待用户新明确授权命名站点。B 的 live 研究验收（§8.8/8.9）与 A 的 live patch 验收一并在此时执行。
- **R-A4 few-shot**：A 遗留——若 live patch 命中率低再加 patch few-shot（会改 agent 指纹）；B 不改。
- **后续子项目**：C（多计划）→ D（恢复码）→ E（导出）→ F（配额）。
- **可选跟进**（待用户）：prompt.ts 考研数学范例中性化；ConstraintDrawer placeholder。