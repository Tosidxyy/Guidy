# CALENDAR_AGENT_REFACTOR_REPORT

日期：2026-11-19 · 分支：main · 基线提交：8fd62c5 → 本次：8ece9f2 / cba3362

## 1. 原有代码的实际架构

调用链（与任务书中的逻辑分层对应，但文件名不同）：

```
用户自然语言
→ POST /api/chat/send（functions/routes/chat.ts，SSE 202 流式）
→ LLM（dev 本地：OpenAI 兼容适配器 dev/qca-openai.ts；线上：QCA adapter functions/qca/live.ts）
→ functions/qca/project.ts 投影器：delta / progress / artifact / status
→ functions/artifacts.ts parseModelText：JSON → constraint_set | patch | question_card（zod 校验）
→ chat 内预求解 solve()：不可行则把违例反馈给模型重试（≤3 次），仍不可行用
   shared/engine/fit.ts trimArtifactToFit 按优先级降次/暂缓
→ 前端方案卡（components/chat/PlanCardPanel.tsx）用户确认
→ lib/useCommitPlan.ts + lib/commitInput.ts：前端本地 solve 出 hash
→ POST /api/plans/commit（functions/routes/plans.ts）：服务端重新求解（以服务端为准）、
   幂等（commit_log.preview_id）、整表替换写库
→ DB（Sites function_backend，11 张表：plans/task_defs/constraints/blocks/...）
→ 响应返回真实 block id（= 日历事件 id，DB uuid）
→ 前端 importState + invalidate ['plans','calendar'] 重新拉取
```

模型对应关系：
- **Task** = `TaskDef`（shared/schemas.ts）：key/title/category/duration_min/frequency(once|daily|per_week)/priority/splittable/preferred_period/notes
- **ScheduleBlock** = `Block`（shared/types.ts）：task_key/title/start_utc/end_utc/origin(engine|manual|fixed)/pinned
- **CalendarEvent** = `blocks` 表行（commit 后由数据库生成真实 uuid）
- 全局约束：busy_window / active_window / daily_cap / mutex / preferred_period / buffer / fixed_block / deadline
- 调度引擎：shared/engine/solve.ts（确定性贪心：active∩非busy∩每日额度，buffer、互斥、固定块、拆分、跨周配额）
- 冲突检测：shared/engine/conflicts.ts（跨计划）；固定日程物化：functions/routes/calendar.ts（共享日历，plan 级块 + 访客级块）

## 2. 已确认 Bug 的根因（均有复现证据）

**R1. 写失败被静默吞掉（最严重，对应“AI 说成功但日历没写”）**
SDK 的 insert/update/delete 返回 `{data,error}`，不抛异常；只有读路径经 `rows()` 检查错误。所有写调用点（plans/calendar/patches/profile…）丢弃了返回值。云端任何约束错误（NOT NULL、外键）都会得到 200 + 空/缺块。复现：共享块插入在云端因 `plan_id NOT NULL + FK plans(id)` 失败，接口仍 200。

**R2. 共享日历块用 `plan_id = NULL`，与云端 schema 不兼容**
云端 blocks.plan_id 为 NOT NULL 且外键引用 plans(id)；本地 fake-db 不校验，掩盖了问题。部署到 Sites 后共享日历写入全部失败（被 R1 隐藏）。

**R3. 同一请求产生 2–3 份相同事件（真实 AI 实测）**
用户输入“明天下午2点学习两小时”，模型输出同名任务 study_2h + 当天 14:00–16:00 的 fixed_block。原实现：
(a) 引擎既排任务又保留固定块 → 计划内 2 个学习块；
(b) commit 又把 fixed_block 物化进共享日历 → 第 3 份；
(c) 计划固定块与物化块重复。
实测结果：计划 2 块（共 4 小时）+ 共享日历 1 块。

**R4. 每日上限可被拆分块击穿（硬约束失效）**
求解拆分时按“slot 剩余长度”切块，未按当天剩余额度截断：一次可落 1500 分钟块，daily_cap=120 形同虚设。

**R5. 固定事件之间不校验重叠**
两个 fixed_block（会议 vs 学习）在同一天重叠时无任何违例，双双落库。

**R6. 缺少“部分成功”的概念**
`SolveOutput` 只有 violations/compromises；无法区分“全排下/排了一部分/完全排不下”，commit 只能全拒或全过。

**R7. 落库无自检**
commit 写完后不再读回校验，部分写成功（如块少一条）也返回 200。

**R8. 类型门禁从未跑通（deno check）**
vendor zod 的 .js + .d.ts 在 Deno 下未生效（推断全变 any）、fit.ts 无扩展名导入、chat.ts 的 null 联合类型错误——vitest 不查类型所以一直没暴露。

## 3. 修改的模块和接口

| 模块 | 改动 |
|---|---|
| functions/db.ts | 新增 `strictDb()`：代理 DbQuery，任何失败（含写）抛出；`application()` 统一接入 |
| functions/app.ts | 注入 strictDb |
| shared/constants.ts | 新增 `SHARED_BLOCK_PLAN_ID`（哨兵 uuid）与 `SHARED_PLAN_OWNER` |
| functions/routes/calendar.ts | 共享块改用哨兵 plan_id；`ensureSharedPlan()` 幂等创建系统计划行满足外键；fixed_block 不再物化（只物化 busy_window）；写入经 rows() 检查 |
| functions/routes/plans.ts | commit：feasibility/unplaced 进响应与 422 details；落库自检（块数/总时长不符 → 500 write_verification_failed）；deliverPlan 相关查询改哨兵 |
| functions/routes/profile.ts, functions/ownership.ts | 共享块查询/转移/删除改哨兵 |
| shared/engine/solve.ts | 同名 fixed_block 计入任务落位（去重）；固定/钉住块重叠校验；daily_cap 截断拆分块；输出 `feasibility` + `unplaced` 明细 |
| shared/types.ts | SolveOutput 增加 feasibility/unplaced；新增 UnplacedWork/Feasibility 类型 |
| shared/engine/fit.ts | 补 .ts 扩展名（Deno） |
| vendor/zod.ts | `// @ts-types="npm:zod@3.25.76"` 恢复类型推断 |
| functions/routes/chat.ts, functions/types.ts | 类型修复；artifact kind 增加 question_card；pendingViolations 用 Violation |
| functions/prompt.ts | 新增“明确时间”契约：同名 once 任务 + 同日 fixed_block，系统去重；fixed_block 只用于用户明确给出的时间 |
| dev/fake-db.ts | 与云端一致：blocks.plan_id NOT NULL + 外键校验 |
| dev/e2e-minimal.mjs（新） | 真实模型最小闭环 E2E：chat → artifact → commit → 读回校验真实 id |
| functions/__tests__/scenarios.test.ts（新） | 六类验收场景 |
| functions/__tests__/db.test.ts（新） | strictDb 写失败必抛 |
| 前端 | 设置页补回“删除全部数据”（5140506，独立于本次 Agent 改造） |

## 4. 新增的能力

1. **写失败可见**：任何 DB 错误 → 明确 4xx/5xx + diagnostic_id，不再有 200 假成功。
2. **共享日历云端可用**：哨兵计划行方案（系统所有，对所有按 owner 过滤的查询不可见）。
3. **精确时间零重复**：同一意图只落 1 个事件（真实 AI 实测验证）。
4. **显式可行性状态**：FEASIBLE / PARTIAL / INFEASIBLE（UNKNOWN 保留给未来超时求解）；PARTIAL 附带每个任务的 target/placed/missing 与原因。
5. **硬约束修复**：固定事件重叠报违例；每日上限对拆分块生效。
6. **落库自检**：commit 读回不一致直接失败，不静默半写。
7. **最小闭环 E2E 脚本**：可对任意本地实例跑真实模型验收。
8. **类型门禁恢复**：deno check 可作为可信门禁运行。

## 5. 测试命令与执行结果（本次实际运行）

```
npm run sync:function   # 通过（functions 使用 functions/shared 同步副本）
npx vitest run          # 62 文件 / 498 用例全部通过
npm run check:function  # deno check 通过
npm run build           # tsc + vite + function package 通过
node dev/e2e-minimal.mjs "明天下午2点学习两小时。"   # 真实模型（deepseek-reasoner）
```

真实 AI E2E 结果（修复后）：
- chat 2.6s，artifact=constraint_set，status=completed；
- commit 200；读回 1 个块：学习 14:00–16:00（UTC+8），120 分钟，task_key=study_fri_pm，真实 uuid id；
- 共享日历 0 块（无重复）；期望 120 分钟 = 实际 120 分钟 → PASS。

修复前同一场景：计划 2 块（12:00–14:00 任务块 + 14:00–16:00 固定块）+ 共享日历 1 块（共 3 份）→ FAIL。

验收场景（functions/__tests__/scenarios.test.ts，全部通过）：
- 场景一（简单创建）：由真实 AI E2E + commit 去重用例覆盖。
- 场景二（固定事件冲突）：重叠 fixed 块 → 422 engine_infeasible，含“重叠”违例，DB 零写入。
- 场景三（复杂拆分）：5×2h + 每日≤3h + 截止日 → 5 块共 600 分钟，FEASIBLE；容量不足 → PARTIAL 且 missing = target − placed。
- 场景四（动态重规划）：reschedule(keep_pinned) 保留 pinned 块原时间，其余任务重排。
- 场景五（写入失败）：blocks 写入持续失败 → 非 2xx 错误（不再 200）。
- 场景六（完整一周）：睡眠/上班/通勤/课程/健身/阅读/家务/约会混合，无重叠、学习量受每日上限约束。

## 6. 尚未解决的问题（如实）

1. **任务级 deadline / earliest start / 依赖顺序尚未建模**：截止日目前通过全局 deadline + horizon 裁剪表达；任务依赖（先 A 后 B）无字段、无校验。多目标不同截止日需要新字段 + 迁移 + 引擎拓扑排序。
2. **完成进度未建模**：blocks 无 status/completed_at；“已完成任务保留不动”目前只能靠 pinned/manual 表达。动态重规划的“已完成进度”语义需要新列与 API。
3. **UNKNOWN 状态未实现**：现有求解为同步贪心，无超时概念；未引入 OR-Tools（当前规模无需重量级依赖）。
4. **无数据库事务**：commit 为“删除+插入”序列；中途失败会留部分数据，但不会写 commit_log，重试同 preview_id 可收敛；本次增加读回自检把不一致暴露为 500。真正的原子性需平台支持。
5. **云端历史重复数据**：此前部署版本物化出的 fixed 共享块（若有）不会自动清理，需一次性数据清理或删除该计划重建。
6. **前端未展示 feasibility/unplaced**：后端已返回，方案卡与日历尚未呈现“缺口/未排量”和 FEASIBLE/PARTIAL 徽标；commit 的 engine_infeasible 目前仍走“自动放宽重试”toast。
7. **跨计划冲突只报告不解决**：findConflicts 会列出重叠，但不会自动改写另一端计划（按“不擅自修改他人计划”原则保留给用户确认）。
8. **idempotency 仅 preview_id**：重复提交由前端每次生成新 preview_id 保证；无独立的 idempotency_key 字段。

## 7. 当前系统实际能够支持的规划复杂度

- **支持良好**：单/多目标任务；固定事件（会议/课程/约会）；每周重复忙碌（上班/睡眠/通勤）；可安排时段；每日分类上限；精确时间的一次性任务；任务拆分（splittable，受每日上限与最短 25min 约束）；偏好时段（软约束）；硬/软互斥（同日/相邻）；缓冲时间；固定事件冲突检测；优先级取舍（per_week 降次 → 暂缓非每日任务）；PARTIAL 缺口报告；单计划 30 任务 / 40 约束 / 60 天以上跨度（上限 365 天）。
- **部分支持**：多计划共享日历（占用避让正确，但“已完成”无法标记）；任务依赖（不支持）；每任务独立截止（用全局截止近似）；跨计划冲突（检测但不自动修复）。
- **不支持**：最小化移动量的全局最优重排（贪心 + 保留 pinned/manual）；第三方日历同步；事务性批量写入；求解超时控制。
---

# 第二阶段改造记录（2026-11-19）

## 新增数据模型

| 位置 | 字段 | 说明 |
|---|---|---|
| blocks | `status` (text) | planned / in_progress / completed / partial / cancelled / skipped（NULL 视同 planned） |
| blocks | `completed_at` / `actual_duration_min` / `progress_updated_at` | 完成时间、实际完成分钟、进度更新时间 |
| blocks | `plan_version` (int) | 版本化提交用；共享日历块仍用哨兵 plan_id，不参与版本 |
| task_defs | `deadline` / `earliest_start` (text, YYYY-MM-DD) | 任务级日期窗（含边界） |
| task_defs | `depends_on` (text, JSON 数组) | 前置任务 key 列表，最多 8 个 |
| plans | `active_version` (int) | 当前生效版本；历史行 NULL 视同 1 |
| commit_log | `idempotency_key` (text) | 稳定幂等键（缺省回退 preview_id） |

## 数据库迁移

- 新增 `functions/migrations/0007_phase2_progress_deps.sql`（10 个 ADD COLUMN，全部可空无默认值，符合平台受限 DDL）。
- **尚未应用到云端**：本轮未获部署授权，云端仍运行第一阶段的表结构；本地 fake-db/内存库已验证迁移后的行为。

## API 变化

- 新增 `POST /api/blocks/:id/progress`：`{status, actual_duration_min?}`；校验块所有者（计划块查 plans.owner，共享块查 owner_visitor_id）；自动写 completed_at/progress_updated_at；返回真实块行。
- `POST /api/plans/commit`：
  - 新增可选 `idempotency_key`；同 key 重复提交返回首次结果，不再创建重复事件。
  - 版本化写入：CAS 认领 version → 写 plan_version 新行 → 读回校验 → 单行 `active_version` 切换 → 清理旧版本行。失败即清理本版本，旧版本保持有效。并发提交由 version CAS 串行化（冲突返回 409 commit_conflict）。
  - 已完成/进行中/部分完成的块原地升版本（id、时间、进度不丢），不参与重排目标；取消/跳过的块保留记录。
  - 响应与 422 details 均含 `feasibility` / `unplaced`。
- `POST /api/patches/apply`：同样版本化；reschedule 把已完成/进行中/部分完成块视为不可移动事实；进度字段随 patch 保留。
- `GET /api/plans/:id`、`/api/plans`、chat 上下文统一按 `active_version` 读取，历史任务行解码 `depends_on`。

## 前端变化

- 方案卡新增可行性条：FEASIBLE/PARTIAL/INFEASIBLE/UNKNOWN 徽标（服务端 pre-solve 为权威，旧对话回放时同引擎本地预估并标注“本地预估”）；缺口任务的“目标/已排/未排 + 原因”；违例列表（映射到受影响约束的文案，支持 pre-N/ai-N id）；软约束妥协折叠列表。
- 不可行方案禁用「确认并生成」；提交失败的 toast 展示真实违例/缺口明细（不再只有笼统错误）。
- **不再自动放宽硬目标**：容量不足时原样交付 PARTIAL + 服务端生成“可接受取舍建议”（原目标 vs 调整后），用户点「接受取舍建议」才应用；固定事件、硬截止、总时长、每日上限、运动次数、睡眠时段一律不自动修改。
- 块编辑抽屉新增执行进度区（已完成/进行中/取消/重置/记录部分完成分钟），共享日历块提示不支持；已完成块显示勾选与删除线，部分完成虚线边框。
- 提交按钮附带稳定幂等键（计划 id + 版本 + 输入内容哈希），网络重试不重复建事件。

## 调度算法改进

- 依赖图：循环检测（DFS）；有环任务不排且判 INFEASIBLE（结构性证明）；拓扑顺序保证前置任务先落位；后置任务只能落在前置任务最后一个块之后的日子。
- 任务级日期窗：earliest_start/deadline 限制允许日期；窗为空判结构性矛盾。
- 排序：最早截止优先（EDF）→ 优先级 → sort_order（替代原先纯优先级贪心）。
- 可行性判定：只有结构性矛盾（循环依赖、固定事件重叠、硬互斥结构矛盾、日期窗为空）返回 INFEASIBLE；纯容量不足返回 PARTIAL，完全排不出且无结构证明返回 UNKNOWN——“贪心没找到”不再被谎报为“不可行”。
- 未引入 OR-Tools：现有规模与稳定性优先，回溯/局部交换留待有证据的下一步。

## 已完成的问题

- 前端可行性与部分规划展示（P0）。
- 自动放宽改为显式取舍提案（P0）。
- 提交安全与幂等：版本化提交、稳定幂等键、并发 CAS、失败保旧版本（P0，方案 B，因平台无事务）。
- 任务完成状态模型 + 任务级进度汇总 + 已完成不回排（P1）。
- 任务级截止/最早开始/依赖关系 + 环检测（P1）。
- 贪心“未找到 ≠ 不可行”（P1）。
- 真实场景测试：依赖顺序、循环依赖、多截止、部分可行、进度保留、幂等、并发、写失败保旧版本、时区换算、共享日历隔离（P2 12 类中的全部可本地覆盖项）。

## 仍然存在的问题（如实）

1. **云端迁移未执行**：0007 需要随下一次授权的部署走 Sites 迁移流程；在此之前云端不能用进度/依赖/版本化功能（线上仍是第一阶段代码）。
2. **版本化提交为“单行切换 + 清理”，非真正事务**：极端窗口内并发提交时，verify 前后的交错可能让一方得到 409（已处理），但理论上的跨表部分写入仍依赖“旧版本不被触碰 + 清理失败仅留不可见过期行”的策略；没有跨服务原子性。
3. **UNKNOWN 未在 UI 上区分处理**：显示为“待确认”，没有进一步搜索（无回溯/CP-SAT）。
4. **进度只支持块级上报与任务级汇总**：没有“任务完成但块未覆盖”的独立任务级状态行；任务级进度完全由块聚合推导。
5. **跨午夜事件仍不支持**（busy_window start 必须早于 end）；时区换算已覆盖同日场景。
6. **贪心最优性未保证**：EDF + 依赖序改善了顺序敏感度，但未做回溯搜索，极端反例仍可能 PARTIAL 而实际可行。
7. **前端进度 UI 属最小实现**：块抽屉按钮；日历上未做拖拽式“打勾”交互，也未展示任务级进度条。
8. **撤销栈与版本化交互**：patch 撤销沿用原有乐观锁，未与 active_version 的故事线统一。

## 测试与验证

```
npm run sync:function   # 通过
npx vitest run          # 63 文件 / 509 用例全部通过（含新增 phase2.test.ts 11 例）
npm run check:function  # deno check 通过
npm run build           # tsc + vite + function package 通过
```

- 新增 `functions/__tests__/phase2.test.ts`：依赖顺序/循环依赖/日期窗/多截止/贪心非证明/完成进度聚合与回排保留/幂等键/并发提交/提交中失败保旧版本/时区换算/共享日历隔离。
- 真实云端：本轮**未部署、未在云端验证**；第一阶段真实 AI E2E 仍然有效（最小闭环），第二轮功能待迁移应用后需重新做一次线上验收。
