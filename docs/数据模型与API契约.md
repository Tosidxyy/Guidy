# Guidy 数据模型与 API 契约

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v0.1（草案，待评审） |
| 更新日期 | 2026-11-16 |
| 上游文档 | [PRD.md](./PRD.md) v0.1 · [技术方案.md](./技术方案.md) v0.2 |
| 地位 | 前后端共同遵守的接口契约；Schema 以本文 Zod 定义为准，代码从 `shared/schemas.ts` 单一来源生成 |

---

## 1. 通用约定

| 项 | 约定 |
| --- | --- |
| Base path | `/functions/v1/app/api`（同源；Function 内剥离前缀后匹配） |
| 身份 | 除 `GET /health`、`GET /templates`、`GET /templates/:id` 外，全部路由经 `requireUser(ctx)` 取得 `visitor_id`；私有资源逐路由归属校验，跨访客 403 |
| ID | 服务端 uuid（`gen_random_uuid()`）；幂等键 `preview_id` / `request_id` 由**客户端**生成 uuid |
| 时间 | 存储与传输一律 UTC ISO-8601（`2026-11-16T01:00:00Z`）；"每日时段"类字段用本地 `HH:mm` + 计划时区解释；日期用 `YYYY-MM-DD` |
| 时区 | `plans.timezone` 为 IANA 名（如 `Asia/Shanghai`），默认浏览器时区 |
| 乐观并发 | `plans.version` 单调递增；写操作携带 `base_version`，不匹配 → 409 `version_conflict` + 当前全量状态 |
| 幂等 | 所有"确认落库"类写操作携带 `preview_id`；重复提交返回首次结果（200），不重复执行 |
| 错误包络 | `{ "error": { "code", "message", "diagnostic_id", "details?" } }`；message 为用户可读中文；diagnostic_id 为服务端日志关联 ID |
| 分页 | `?page=1&page_size=20`（默认 20，上限 50）；响应 `{ items, page, page_size, total }` |
| 输入上限 | 消息 ≤2000 字符；计划标题 ≤60；模板标题 ≤60、描述 ≤500；标签 ≤3 个、每个 ≤12 字符；单计划 task_defs ≤30、blocks ≤300、constraints ≤40 |
| 引擎版本 | `ENGINE_VERSION = 1`（常量，shared/constants.ts）；算法/语义变更必须递增 |

---

## 2. 实体关系总览

```
visitor（平台身份，不建表）
  ├── plans 1─N task_defs / constraints / blocks
  ├── conversations 1─N messages
  │        └── dispatch_intents（幂等派发）
  ├── templates 1─N template_likes / template_uses
  ├── recovery_codes
  └── quotas（visitor_id × date）
plans.commit_log / patch_log（幂等落库记录）
templates.source_plan_id → plans（发布溯源）
plans.source_template_id → templates（套用溯源）
```

---

## 3. 表结构（Postgres，`app` schema）

迁移走平台 reviewed migration 流程；以下为完整 DDL 草案。

```sql
CREATE SCHEMA IF NOT EXISTS app;

-- 计划
CREATE TABLE app.plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_visitor_id text NOT NULL,
  title           text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  horizon_start   date NOT NULL,              -- 计划首日（计划时区）
  horizon_days    int  NOT NULL DEFAULT 7 CHECK (horizon_days IN (7, 14)),
  timezone        text NOT NULL DEFAULT 'Asia/Shanghai',
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  source_template_id uuid,                    -- 套用溯源，可空
  version         int  NOT NULL DEFAULT 1,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plans_owner_idx ON app.plans (owner_visitor_id, created_at DESC) WHERE deleted_at IS NULL;

-- 任务定义（排程输入，区别于落位后的 blocks）
CREATE TABLE app.task_defs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     uuid NOT NULL REFERENCES app.plans(id) ON DELETE CASCADE,
  key         text NOT NULL,                  -- 计划内稳定标识，AI/引擎引用用
  title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  category    text NOT NULL,                  -- 8 分类枚举，见 §4.1
  duration_min int NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
  frequency   jsonb NOT NULL,                 -- §4.2
  priority    text NOT NULL DEFAULT 'mid' CHECK (priority IN ('high','mid','low')),
  splittable  boolean NOT NULL DEFAULT false,
  preferred_period text,                      -- morning/afternoon/evening/night，可空
  sort_order  int NOT NULL DEFAULT 0,
  UNIQUE (plan_id, key)
);

-- 约束
CREATE TABLE app.constraints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     uuid NOT NULL REFERENCES app.plans(id) ON DELETE CASCADE,
  type        text NOT NULL,                  -- 8 类型枚举，见 §4.3
  payload     jsonb NOT NULL,
  source      text NOT NULL DEFAULT 'user' CHECK (source IN ('user','ai','template')),
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX constraints_plan_idx ON app.constraints (plan_id);

-- 任务块（日历落位）
CREATE TABLE app.blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     uuid NOT NULL REFERENCES app.plans(id) ON DELETE CASCADE,
  task_def_id uuid REFERENCES app.task_defs(id) ON DELETE SET NULL,
  title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  category    text NOT NULL,
  start_utc   timestamptz NOT NULL,
  end_utc     timestamptz NOT NULL CHECK (end_utc > start_utc),
  priority    text NOT NULL DEFAULT 'mid' CHECK (priority IN ('high','mid','low')),
  pinned      boolean NOT NULL DEFAULT false, -- 用户钉住/fixed_block，引擎不得移动
  origin      text NOT NULL DEFAULT 'engine' CHECK (origin IN ('engine','manual','fixed')),
  notes       text CHECK (char_length(notes) <= 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX blocks_plan_start_idx ON app.blocks (plan_id, start_utc);

-- 对话
CREATE TABLE app.conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_visitor_id text NOT NULL,
  plan_id     uuid REFERENCES app.plans(id) ON DELETE SET NULL,
  qca_session_id text,                        -- 懒初始化后回填
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','interrupted','failed')),  -- 另有 'archived'：计划被删除时归档，列表与恢复都过滤
  last_seq    bigint NOT NULL DEFAULT 0,      -- 已持久化最大消息 seq（游标基准）
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_owner_idx ON app.conversations (owner_visitor_id, updated_at DESC);

-- 消息（seq 为对话内单调游标）
CREATE TABLE app.messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES app.conversations(id) ON DELETE CASCADE,
  seq         bigint NOT NULL,
  role        text NOT NULL CHECK (role IN ('user','assistant','system')),
  kind        text NOT NULL CHECK (kind IN ('text','constraint_set','patch','status','error')),
  content     text NOT NULL DEFAULT '',       -- text 类流式期间增量追加
  payload     jsonb,                          -- artifact 类结构化产物（校验后）
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);

-- 幂等派发协调
CREATE TABLE app.dispatch_intents (
  request_id  uuid PRIMARY KEY,               -- 客户端生成
  conversation_id uuid NOT NULL REFERENCES app.conversations(id) ON DELETE CASCADE,
  visitor_id  text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX dispatch_visitor_pending_idx ON app.dispatch_intents (visitor_id) WHERE status = 'pending';

-- 落库幂等记录
CREATE TABLE app.commit_log (
  preview_id  uuid PRIMARY KEY,               -- 客户端生成
  visitor_id  text NOT NULL,
  plan_id     uuid NOT NULL REFERENCES app.plans(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.patch_log (
  preview_id  uuid PRIMARY KEY,
  visitor_id  text NOT NULL,
  plan_id     uuid NOT NULL REFERENCES app.plans(id) ON DELETE CASCADE,
  result_version int NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 社区模板
CREATE TABLE app.templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_visitor_id text NOT NULL,
  source_plan_id uuid REFERENCES app.plans(id) ON DELETE SET NULL,
  title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  tags        text[] NOT NULL DEFAULT '{}',
  snapshot    jsonb NOT NULL,                 -- 脱敏结构，§9
  status      text NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden','deleted')),
  is_official boolean NOT NULL DEFAULT false,
  use_count   int NOT NULL DEFAULT 0,
  like_count  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX templates_feed_idx ON app.templates (status, created_at DESC);
CREATE INDEX templates_tags_idx ON app.templates USING gin (tags);

CREATE TABLE app.template_likes (
  template_id uuid NOT NULL REFERENCES app.templates(id) ON DELETE CASCADE,
  visitor_id  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, visitor_id)
);
CREATE TABLE app.template_uses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES app.templates(id) ON DELETE CASCADE,
  visitor_id  text NOT NULL,
  plan_id     uuid NOT NULL REFERENCES app.plans(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, visitor_id, plan_id)   -- 同一计划重复套用不重复计数
);

-- 恢复码（P1）
CREATE TABLE app.recovery_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id  text NOT NULL,
  code_hash   text NOT NULL,                  -- SHA-256，明文仅展示一次
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 配额
CREATE TABLE app.quotas (
  visitor_id  text NOT NULL,
  day         date NOT NULL,
  chat_turns  int NOT NULL DEFAULT 0,
  publishes   int NOT NULL DEFAULT 0,
  PRIMARY KEY (visitor_id, day)
);
```

**无通用事务的替代策略**（平台 SDK 约束）：唯一键幂等（commit_log/patch_log/template_uses）+ `plans.version` 条件更新 + 失败对账。多表写入顺序：先写幂等记录占位 → 写业务表 → 更新 version；中途失败返回可重试错误，重试凭 preview_id 收敛。

---

## 4. 领域类型与 Zod Schema（`shared/schemas.ts`）

### 4.1 分类枚举（固定 8 类，色板见 constants.ts）

```ts
const Category = z.enum(['study','fitness','reading','work','life','creative','rest','other']);
```

### 4.2 任务定义与频次

```ts
const Frequency = z.discriminatedUnion('type', [
  z.object({ type: z.literal('per_week'), count: z.number().int().min(1).max(14) }),
  z.object({ type: z.literal('daily') }),
  z.object({ type: z.literal('once') }),
]);

const TaskDef = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,24}$/),
  title: z.string().min(1).max(60),
  category: Category,
  duration_min: z.number().int().min(5).max(480),
  frequency: Frequency,
  priority: z.enum(['high','mid','low']).default('mid'),
  splittable: z.boolean().default(false),
  preferred_period: z.enum(['morning','afternoon','evening','night']).optional(),
});
```

> 与 PRD 附录 A 的差异：频次统一为带 `type` 标签的联合（原 `{per_week:4}`/`{daily:true}` 两种形状不一致），PRD 附录需回写，见 §12。

### 4.3 约束（8 类型，payload 按类型判别）

```ts
const HHmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Weekday = z.number().int().min(0).max(6);          // 0=周日，与 JS getDay 一致
const Period = z.enum(['morning','afternoon','evening','night']);
// 时段边界（constants）：morning 06–12 / afternoon 12–18 / evening 18–22 / night 22–24

const ConstraintPayload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('busy_window'),
    weekday: Weekday.optional(), date: z.string().date().optional(),   // 二选一：每周循环 / 特定日期
    start: HHmm, end: HHmm, label: z.string().max(30).optional() })
    .refine(c => (c.weekday === undefined) !== (c.date === undefined), 'weekday 与 date 必须二选一'),
  z.object({ type: z.literal('active_window'),
    start: HHmm, end: HHmm, weekdays: z.array(Weekday).min(1).optional() }), // 缺省=每天
  z.object({ type: z.literal('daily_cap'),
    category: Category, max_minutes: z.number().int().min(30).max(960) }),
  z.object({ type: z.literal('mutex'),
    subjects: z.object({
      kind: z.enum(['category','task']),        // 分类互斥 或 任务互斥（已拍板扩展）
      values: z.array(z.string()).length(2),    // category 枚举值 或 task_def key
    }),
    mode: z.enum(['no_adjacent','no_same_day']),
    strength: z.enum(['soft','hard']).default('soft') })
    .refine(c => c.subjects.values[0] !== c.subjects.values[1], '互斥主体必须不同'),
  z.object({ type: z.literal('preferred_period'),
    task_key: z.string().optional(), category: Category.optional(),     // 二选一
    period: Period, strength: z.literal('soft').default('soft') })
    .refine(c => (c.task_key === undefined) !== (c.category === undefined)),
  z.object({ type: z.literal('buffer'),
    minutes: z.number().int().min(0).max(120) }),
  z.object({ type: z.literal('fixed_block'),
    title: z.string().max(60), category: Category,
    weekday: Weekday.optional(), date: z.string().date().optional(),
    start: HHmm, end: HHmm })
    .refine(c => (c.weekday === undefined) !== (c.date === undefined)),
  z.object({ type: z.literal('deadline'),
    date: z.string().date(), label: z.string().max(30) }),
]);
```

**语义裁定**（回应 PRD 待评审点 2 与术语歧义）：

- `mutex` 主体支持**分类或任务 key**（`subjects.kind`，已拍板）：考研场景"数学与英语不连续学"建模为 `{kind:'task', values:['math','english']}`；"学习与健身同日不共存"建模为 `{kind:'category', values:['study','fitness']}`。引擎将 task key 解析为对应块集合后统一判定。
- `no_adjacent` = 同日两块之间至少间隔一个 buffer（默认 15min）且不得紧挨；`no_same_day` = 同日不共存。
- 默认强度 `soft`（违反标"妥协项"），确认卡上可切 `hard`。
- `fixed_block` 由引擎物化为 `pinned=true, origin='fixed'` 的 block；用户手动钉住的 block 同样不可被引擎移动。

### 4.4 AI 结构化产物

```ts
const ConstraintSetArtifact = z.object({
  type: z.literal('constraint_set'),
  plan_title: z.string().max(60),
  horizon_start: z.string().date().optional(),  // 用户指定开始日（「下周」等相对日期换算）；缺省沿用当前计划开始日
  horizon_days: z.union([z.literal(7), z.literal(14)]).default(7),
  task_defs: z.array(TaskDef).min(1).max(30),
  constraints: z.array(ConstraintPayload).max(40),
  clarifications_needed: z.array(z.string().max(200)).max(2),  // 非空时前端先追问，不出确认卡
});

const PatchOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_task_def'), value: TaskDef }),
  z.object({ op: z.literal('update_task_def'), key: z.string(), patch: TaskDef.partial() }),
  z.object({ op: z.literal('remove_task_def'), key: z.string() }),
  z.object({ op: z.literal('add_constraint'), value: ConstraintPayload, client_id: z.string().uuid().optional(), source: z.enum(['user','ai','template']).optional(), enabled: z.boolean().optional() }),
  z.object({ op: z.literal('update_constraint'), id: z.string().uuid(), patch: z.object({ payload: ConstraintPayload.optional(), enabled: z.boolean().optional(), source: z.enum(['user','ai','template']).optional() }) }),
  z.object({ op: z.literal('remove_constraint'), id: z.string().uuid() }),
  z.object({ op: z.literal('add_block'), value: ManualBlock, client_id: z.string().uuid().optional() }),   // §4.5
  z.object({ op: z.literal('update_block'), id: z.string().uuid(), patch: ManualBlock.partial() }),
  z.object({ op: z.literal('move_block'), id: z.string().uuid(), start_utc: z.string().datetime(), end_utc: z.string().datetime() }),
  z.object({ op: z.literal('remove_block'), id: z.string().uuid() }),
  z.object({ op: z.literal('reschedule'), scope: z.enum(['affected_only','all']).default('affected_only'), keep_pinned: z.literal(true) }),
  z.object({ op: z.literal('clear_plan') }),
]);

// 人工编辑与撤销专用的扩展操作；不进 PatchArtifact，AI 不能改计划元数据。
const ApplyOp = z.union([
  PatchOp,
  z.object({ op: z.literal('update_plan'), patch: z.object({ title: z.string().min(1).max(60).optional(), horizon_start: z.string().date().optional(), horizon_days: z.union([z.literal(7), z.literal(14)]).optional(), timezone: z.string().min(1).max(64).optional() }).refine((p) => Object.keys(p).length > 0) }),
]);

const PatchArtifact = z.object({
  type: z.literal('patch'),
  summary: z.string().max(200),
  ops: z.array(PatchOp).min(1).max(30),
});
```

业务校验（Zod 之后）：时长>0、窗口 start<end、busy 不越出 active、mutex subjects 可解析（category 存在于枚举 / task key 存在于 task_defs）、move_block 落点合法（`validatePlacement`）、reschedule 不得触碰 pinned。校验失败 → 服务端要求模型重试 ≤2 次 → 仍失败返回 `artifact_invalid`。

### 4.5 手动块与落点校验

```ts
const ManualBlock = z.object({
  title: z.string().min(1).max(60),
  category: Category,
  start_utc: z.string().datetime(),
  end_utc: z.string().datetime(),
  priority: z.enum(['high','mid','low']).default('mid'),
  pinned: z.boolean().default(false),
  notes: z.string().max(500).optional(),
});
// validatePlacement(block, planState) → { ok } | { ok:false, hard?:Violation, soft?:Violation[] }
// 硬违反：busy/active/daily_cap/fixed 重叠/mutex-hard/块重叠 → 禁止释放
// 软违反：preferred/mutex-soft/buffer → 允许但标黄
```

---

## 5. 排程引擎契约（`shared/engine`）

```ts
interface SolveInput {
  engine_version: 1;
  horizon_start: string;          // YYYY-MM-DD（计划时区）
  horizon_days: 7 | 14;
  timezone: string;
  task_defs: TaskDef[];
  constraints: Constraint[];      // 含 id/enabled
  pinned_blocks: Block[];         // 已钉住/手动块，作为不可动输入
}
interface SolveOutput {
  blocks: NewBlock[];             // 不含 pinned 输入本身；start/end UTC
  violations: Violation[];        // 硬约束无解项：{task_key?, constraint_id?, reason, suggestion}
  compromises: Compromise[];      // 软约束妥协项：{block_ref, constraint_id, reason}
  stats: { placed: number; unplaced: number; solve_ms: number };
}
solve(input: SolveInput): SolveOutput   // 纯函数、确定性
```

**确定性规则**：候选槽按 (日期, 起始分钟) 升序；任务排序按 (priority 权重, 窗口受限度, sort_order, key) 稳定排序；同分按 key 字典序；不使用 `Date.now()`/随机数；`solve_ms` 仅统计不参与结果。

**result_hash**：`SHA-256(stableStringify({engine_version, blocks: 按(start_utc,title)排序后的 [{task_def_key,title,category,start_utc,end_utc,pinned}]}))`；前端 commit/apply 携带，服务端重算比对。不一致 → 200 但响应 `server_authoritative: true` + 服务端结果，前端提示"以服务端为准"。

**运行位置**（技术方案 v0.2 已拍板）：前端求解用于生成预览/补丁 diff/拖拽校验；服务端 commit/apply 重算为权威。`ENGINE_VERSION` 不匹配 → 409 `engine_version_mismatch`，提示刷新。

---

## 6. API 端点契约

### 6.1 会话与对话

| 端点 | 说明 |
| --- | --- |
| `GET /health` | 匿名；`{ ok:true, engine_version:1 }` |
| `GET /me` | `{ visitor_id, quotas:{ chat_remaining, publish_remaining }, has_recovery_code }` |
| `GET /conversations?plan_id?` | 当前访客对话列表（含 plan 绑定），不含 archived |
| `POST /chat/send` | 见下 |
| `GET /chat/history?conversation_id&page` | 持久化消息分页（role/kind/content/payload/seq） |
| `GET /chat/events?conversation_id&cursor` | SSE 增量回放+续流，见 §7 |
| `POST /chat/interrupt` | `{conversation_id}` → 取消上游读取，status=interrupted，投影 `status` 事件 |

**POST /chat/send**

```jsonc
// Request
{ "conversation_id": "uuid|null",   // null=新建对话（可附 plan_id）
  "plan_id": "uuid|null",
  "text": "我12月20日考研……",        // ≤2000 字符
  "today": "2026-11-18",             // 客户端本地日期，供模型换算「下周」等相对日期
  "timezone": "Asia/Shanghai",       // 客户端时区
  "request_id": "uuid" }            // 客户端幂等键
// Response: 202，Content-Type: text/event-stream（事件契约见 §7）
// 首个事件 accepted；同访客已有 pending 派发 → 409 dispatch_busy
// 新对话带 plan_id 会绑定到该计划；未绑定对话续聊时补绑；已归档对话续聊会新建对话
// 配额耗尽 → 429 quota_exceeded；重复 request_id → 回放既有流/结果
```

服务端顺序：归属/大小校验 → 配额原子递增 → 并发检查 → 插入 dispatch_intent(pending) → 懒初始化 QCA Session → 派发 → 投影+持久化 → done/failed 回填。**结果未知保持 pending**，下次 send/events 时先对账（查上游会话历史判定是否已送达）。

### 6.2 计划

| 端点 | 说明 |
| --- | --- |
| `GET /plans` | 列表（不含 blocks），`{items:[{id,title,status,horizon_start,horizon_days,timezone,version,updated_at}]}` |
| `POST /plans` | `{title,horizon_start,horizon_days,timezone}` → 空 draft 计划 |
| `GET /plans/:id` | 全量 `{plan, task_defs, constraints, blocks}`（含 version） |
| `PATCH /plans/:id` | `{base_version, title?, timezone?, horizon_start?, horizon_days?, status?}` → version+1 |
| `DELETE /plans/:id` | 软删（deleted_at）；可撤销=恢复 deleted_at |
| `POST /plans/commit` | 见下 |

**POST /plans/commit**（生成确认 / 模板套用后首次落库）

```jsonc
// Request
{ "preview_id": "uuid",
  "plan_id": "uuid|null",           // null=新建；非空=覆盖该 draft 的 task_defs/constraints/blocks
  "input": { /* SolveInput  minus pinned_blocks，另含 title */ },
  "result_hash": "sha256hex",
  "engine_version": 1 }
// Response 200
{ "plan": {...}, "task_defs": [...], "constraints": [...], "blocks": [...],
  "version": 2, "server_authoritative": false,
  "violations": [...], "compromises": [...] }
// 幂等：preview_id 已存在 → 直接返回首次结果
// 无解（violations 非空）→ 422 engine_infeasible + 冲突报告，不落库
```

### 6.3 块与约束（手动编辑直连通道，与 Patch 共用 validatePlacement）

> **当前实现（P2）**：手动移动/缩放块复用 `POST /patches/apply` 的 `move_block`——带 `plan_id` + `base_version`，服务端按该计划的约束/块校验落点、version+1 落库，并返回 `inverse_ops` 供撤销。下列独立块 CRUD 端点仍为规划项。

> **P2b 扩展**：块级新增/删除/移动/缩放/字段编辑统一走 `POST /patches/apply`。`add_block` 可带 `client_id`（UUID），服务端按该 ID 落库；删除的逆操作携带原 ID，撤销恢复同一块。客户端以每计划 `serverVersion` 作为 `base_version`；`409 version_conflict` 回滚乐观更新并重新拉取，不自动重放。清空当前计划使用 `{"op":"clear_plan"}`，其逆操作会重放任务、约束与块，可撤销。
>
> **P2c 扩展**：任务定义、约束与计划元数据同样走该端点。`add_constraint` 可带 `client_id`（UUID），服务端按该 ID 落库并在整表重写时保留，撤销删除后 ID 不变。计划标题/开始日/时区/horizon 使用 `{"op":"update_plan","patch":{...}}`（`ApplyOp`，AI artifact 不可用）；改 horizon 或时区会触发重排。元数据编辑同样进入 per-plan 撤销栈。

| 端点 | 说明 |
| --- | --- |
| `POST /plans/:id/blocks` | `{base_version, block: ManualBlock}` → 校验落点 → 201 `{block, version}`；硬违反 → 422 `placement_invalid`+reason |
| `PATCH /blocks/:id` | `{base_version, patch}`（含移动=改 start/end，同样校验）→ `{block, version}` |
| `DELETE /blocks/:id` | `{base_version}` → `{version, inverse_op}`（供撤销） |
| `POST /plans/:id/constraints` | `{base_version, constraint:{type,payload}}` → 201；**不自动重排**，前端本地试算后走 patches/apply |
| `PATCH /constraints/:id` | `{base_version, patch:{payload?,enabled?}}` |
| `DELETE /constraints/:id` | `{base_version}` |

### 6.4 补丁（AI 编辑与批量手动编辑统一通道，F4.6）

**POST /patches/apply**

```jsonc
// Request
{ "preview_id": "uuid",
  "plan_id": "uuid",
  "base_version": 3,
  "ops": [ /* PatchOp[]，§4.4 */ ],
  "result_hash": "sha256hex|null",   // 含 reschedule 时必填
  "engine_version": 1 }
// Response 200
{ "version": 4, "blocks": [...], "task_defs": [...], "constraints": [...],
  "inverse_ops": [ /* 逆操作列表，前端压入撤销栈 */ ],
  "diff": { "added":[ids], "removed":[ids], "moved":[{id,from,to}] },
  "compromises": [...], "server_authoritative": false }
// base_version 不匹配 → 409 version_conflict + 当前全量
// 含 reschedule → 服务端重算引擎；无解 → 422 engine_infeasible
```

试算（diff 预览）在**前端本地引擎**完成，无服务端 preview 端点。

### 6.5 社区模板

| 端点 | 说明 |
| --- | --- |
| `GET /templates?sort=newest\|hot&tag&q&page` | 公开；卡片字段 `{id,title,description,tags,task_count,weekly_minutes,use_count,like_count,is_official,created_at}`；hot=like+use 加权 |
| `GET /templates/:id` | 公开；`{...卡片, snapshot, author_label}`（作者显示匿名昵称或"官方示例"/"已注销访客"） |
| `POST /templates` | 发布，见下 |
| `POST /templates/:id/apply` | `{title?, timezone}` → 复制 snapshot 为新 draft 计划（task_defs+保留约束，source='template'）→ `{plan_id, missing_constraints:['busy_window','active_window'], conversation_hint}`；use_count 幂等 +1 |
| `POST /templates/:id/like` / `DELETE …/like` | 幂等点赞/取消（P1） |
| `POST /templates/:id/unpublish` | 仅作者；status=deleted（软删），已套用计划不受影响（P1） |

**POST /templates**

```jsonc
// Request
{ "plan_id": "uuid", "title": "在职考研6h/日冲刺周计划",
  "description": "……", "tags": ["备考","学习"] }
// 服务端执行：归属校验 → 发布配额(≤3/日) → 脱敏(§9) → 基线过滤(长度/敏感词)
//   → [P1: QCA 审核异步，命中转 hidden]
// Response 201
{ "template": {...}, "desensitized_preview": { /* 脱敏后 snapshot，供发布前预览 */ } }
// 基线命中 → 422 content_rejected + reason
```

> 发布前预览：前端先调 `POST /templates/desensitize-preview {plan_id}`（只读、不计数）取得脱敏结果展示，用户确认后再 `POST /templates`。

### 6.6 数据主权与恢复

| 端点 | 说明 |
| --- | --- |
| `POST /data/delete-all` | `{confirm_token:"DELETE"}` → 级联删除该访客 plans/conversations/messages/templates(软删)/likes/recovery；返回删除计数 |
| `POST /recovery/generate` | 生成恢复码（明文仅本次响应展示，服务端存哈希）（P1） |
| `POST /recovery/claim` | `{code, strategy:"overwrite"}` → 校验哈希 → 当前设备数据提示导出后覆盖归属（P1） |

---

## 7. SSE 事件契约（`/chat/send` 与 `/chat/events`）

传输：`text/event-stream`；每条 `id: <seq>` + `event: <type>` + `data: <json>`。

| event | data | 持久化 | 说明 |
| --- | --- | --- | --- |
| `accepted` | `{request_id, conversation_id, seq}` | 是（user 消息 seq） | 202 受理语义；**不代表完成** |
| `delta` | `{seq, text}` | 追加到该 seq 的 text 消息 | 增量文本；前端拼接渲染 |
| `artifact` | `{seq, kind:'constraint_set'\|'patch', payload}` | 是（payload 校验后） | 结构化产物；校验失败不出此事件，出 error |
| `status` | `{seq, state:'running'\|'waiting_confirm'\|'completed'\|'interrupted'\|'failed'}` | 是 | 状态机迁移 |
| `error` | `{seq, code, message, diagnostic_id}` | 是 | 可读错误；流随后关闭 |
| `done` | `{seq}` | — | 流正常结束标志 |

**游标与重连**：`cursor = "<seq>:<offset>"`（offset 仅 text 消息内字符偏移）。`GET /chat/events?cursor` 先回放游标之后的持久化内容（text 从 offset 续传），再续接实时流直至 done；**绝不重发用户消息**（F8.3）。新建对话时前端取消旧流 reader，旧 seq 事件不得写入新视图。

---

## 8. 错误码表

| code | HTTP | 语义 | 前端处理 |
| --- | --- | --- | --- |
| `unauthorized` | 401 | 身份缺失/失效 | 提示刷新重建匿名身份 |
| `forbidden` | 403 | 跨访客访问 | 提示无权（A8） |
| `not_found` | 404 | 资源不存在/已删 | 返回列表 |
| `validation_failed` | 422 | Schema/业务校验失败 | 字段级提示 |
| `placement_invalid` | 422 | 落点硬约束违反 | 气泡原因（F3.4） |
| `engine_infeasible` | 422 | 无解 | 冲突报告+放宽建议（A10） |
| `content_rejected` | 422 | 发布审核命中 | 展示原因 |
| `artifact_invalid` | 422 | LLM 产物重试后仍不合格 | 可读错误+保留上下文 |
| `quota_exceeded` | 429 | 每日配额耗尽 | 友好提示+剩余说明 |
| `dispatch_busy` | 409 | 同访客并发派发 | 提示等待当前生成 |
| `version_conflict` | 409 | base_version 过期 | 拉全量+提示重试 |
| `engine_version_mismatch` | 409 | 引擎版本不一致 | 提示刷新页面 |
| `upstream_error` | 502 | QCA 失败 | 重试按钮+诊断 ID |
| `service_unavailable` | 503 | 后端未就绪 | 状态页提示 |

---

## 9. 模板脱敏规则（发布时服务端执行）

| 内容 | 处理 |
| --- | --- |
| task_defs | 保留（key/title/category/duration/frequency/priority/splittable/preferred_period） |
| `busy_window` / `active_window` / `fixed_block` / `deadline` | **剥离**（个人时间锚点；套用者重新采集） |
| `daily_cap` / `mutex` / `buffer` / `preferred_period` | 保留，标记 `suggested:true`（套用者可改） |
| blocks 绝对时间 | **不进入 snapshot**；仅保留相对结构提示（preferred_period 已表达） |
| blocks.notes | 全部剥离 |
| 计划标题 | 不直接沿用，用户在发布表单重写 |
| 作者身份 | 仅存 visitor_id；展示匿名昵称，不暴露任何联系方式 |

```jsonc
// snapshot 结构
{ "schema_version": 1,
  "task_defs": [ /* TaskDef[] */ ],
  "constraints": [ /* 保留类约束 + suggested 标记 */ ],
  "stats": { "task_count": 6, "weekly_minutes": 2100 } }
```

---

## 10. 配额与协调参数（constants.ts 默认值）

| 参数 | 值 | 依据 |
| --- | --- | --- |
| chat_turns / 访客 / 日 | 60 | F1.7 |
| publishes / 访客 / 日 | 3 | F6.9 |
| 并发 pending 派发 / 访客 | 1 | PRD §7 |
| artifact 校验重试 | ≤2 | §6.0 |
| 撤销栈深度 | ≥20 | F4.2 |
| 单计划上限 | task_defs 30 / blocks 300 / constraints 40 | §1 |

---

## 11. 验收映射（PRD §10 → 契约条款）

| 用例 | 契约支撑 |
| --- | --- |
| A2 约束确认卡 | `artifact.constraint_set` + clarifications_needed ≤2 |
| A3 生成零违反 | commit 服务端重算 + violations 非空拒绝落库 |
| A4 拖拽持久化 | blocks PATCH + version；刷新 GET /plans/:id |
| A5 AI 编辑可撤销 | patches/apply inverse_ops |
| A6 脱敏 | §9 规则 + desensitize-preview |
| A7 套用重排 | apply 返回 missing_constraints → 采集 → commit |
| A8 隔离 | 全路由归属校验 → forbidden |
| A9 恢复不重发 | §7 游标回放；reload 只 GET history/events |
| A10 无解报告 | engine_infeasible + Violation.suggestion |
| A12 安全 | rehype-sanitize；PAT 仅 Function；模板隔离标记 |

---

## 12. PRD 回写记录（已确认，v0.2 执行）

1. ✅ 附录 A `frequency` 形状统一为 `{type:'per_week',count}` / `{type:'daily'}` / `{type:'once'}`。
2. ✅ `mutex` 扩展支持 task_keys（`subjects.kind`）；附录 A 示例改为 `{kind:'task', values:['math','english']}`。
3. ✅ 试算改前端本地引擎（无 `/patches/preview`）；生成落库统一 `/plans/commit`；PRD §6.0/§8 同步"引擎双端运行"。
4. ✅ mutex 默认强度裁定：默认 soft、确认卡可切 hard；PRD 待评审点 2 关闭。
5. ✅ 计划时间范围 MVP 收敛为 7/14 天（30 天移出 MVP）；PRD 待评审点 1 关闭。