# M3-E .ics 导出设计（Export Enhancement）

日期：2026-11-16 · 状态：设计已获用户批准（"确认"），待 spec 审阅
上游：PRD F4.5（P1：`.ics` 导入系统日历 + JSON 备份）；技术方案 §ICS/JSON 导出（浏览器端手写序列化，不引入 Storage/后端）；M3 分解 E 项。
分支：Guidy-Qoder（直接工作，不 worktree/merge/push/publish）。

## 0. 已拍板决策

| # | 决策 | 依据 |
|---|---|---|
| Q1 | **范围 = 仅 .ics**；图片导出剔除 | PRD/UIUX 均无图片导出要求；截图分享正是 PRD 要替代的旧形态；YAGNI |
| Q2 | **逐块展开**：每个 Block 一个 VEVENT（绝对时间） | 引擎 placement 受约束影响不规则（每周 N 次/时段窗口/手动钉住），RRULE 无法忠实表达；所见即所得 |
| Q3 | **仅当前计划** | 与现有「导出 JSON」一致；多计划用户先切换再导出；F4.5 未要求批量 |
| 既定 | 纯前端手写序列化，零新依赖、零后端/契约/引擎改动 | 技术方案已拍板；契约无 /api/export；date-fns-tz 都不需要（start_utc 已是 UTC ISO） |

JSON 备份半边 F4.5 已由现有 exportJson/importJson 满足（含约束、zod 校验可再导入），本子项目不动它。

## 1. 架构与模块边界

- **新增 `lib/ics.ts`** — 纯函数模块，两个导出：
  ```ts
  export function buildIcs(state: PlanState, now?: Date): string
  export function icsFileName(title: string): string
  ```
  `buildIcs` 输入当前计划状态（plan + blocks；task_defs/constraints 不参与序列化），输出完整 RFC 5545 日历文本。`now` 仅注入 DTSTAMP 便于测试，缺省 `new Date()`。`icsFileName` 生成净化后的下载文件名（§2.4）。无 DOM、无网络、无副作用 → vitest node 环境直接单测。
- **修改 `components/workbench/SettingsDrawer.tsx`** — 「数据」节新增「导出 .ics」按钮 + `exportIcs()` 下载动作（Blob + URL.createObjectURL + a.click + revoke，与现有 exportJson 同构）。
- 不改：shared/engine、shared/schemas、functions/*、路由、契约、迁移、配额、身份链路。零新 npm 依赖。

## 2. ICS 格式契约（buildIcs 输出规范）

### 2.1 日历外壳

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Guidy//Guidy Scheduler//CN
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:{escaped plan.title}
{VEVENT...}
END:VCALENDAR
```

- 行尾 **CRLF**（`\r\n`），全文以 CRLF 结束。
- `X-WR-CALNAME` 为 TEXT 值，按 §2.3 转义；空标题回退 `plan`。
- 0 个 block 时输出合法空日历（纯函数保持全函数）；「不下载」守卫在 UI 层（§3）。

### 2.2 VEVENT（每个 Block 一个，按 blocks 数组顺序）

```
BEGIN:VEVENT
UID:guidy-{block.id}@guidy
DTSTAMP:{now UTC basic}
DTSTART:{block.start_utc UTC basic}
DTEND:{block.end_utc UTC basic}
SUMMARY:{escaped block.title}
CATEGORIES:{block.category}
DESCRIPTION:{escaped block.notes}   ← 仅当 notes 非空
END:VEVENT
```

- **UTC basic 格式**：`20261116T140000Z`。`start_utc/end_utc` 已是 UTC ISO（zod datetime 保证），转换 = `new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')`。不输出 VTIMEZONE/TZID——导入设备按本地时区显示正确绝对时间，主流日历全兼容。
- **UID 确定性**：`guidy-{block.id}@guidy`（block.id 为引擎/手动块既有 uuid）。重复导入同一计划时主流日历按 UID 更新事件而非重复创建。
- `CATEGORIES` 取 CategoryEnum 值（study/fitness/reading/work/life/creative/rest/other），ASCII token 无需转义。
- 不输出：RRULE、VALARM、STATUS、TRANSP、LOCATION、ORGANIZER（YAGNI）。

### 2.3 TEXT 转义与折行（RFC 5545）

- 转义顺序（先反斜杠自身）：`\` → `\\`，`;` → `\;`，`,` → `\,`，换行（`\r\n`/`\n`/`\r`）→ 字面 `\n`。应用于 SUMMARY/DESCRIPTION/X-WR-CALNAME。
- **折行**：单行超过 **75 八位组**（UTF-8 字节数，不含 CRLF）时折叠：在 ≤75 字节处断开，续行以单个空格开头（空格计入续行 75 字节预算）。折行不得切断多字节 UTF-8 字符——按代码点迭代累计字节数（`TextEncoder` 或逐字符 `encodeURIComponent` 计长），在字符边界断开。
- 实现为内部 helper（`escapeText` / `foldLine`），不导出；通过 buildIcs 输出断言覆盖。

### 2.4 文件名

`guidy-{sanitize(plan.title || 'plan')}.ics`；sanitize 去除 `/ \ : * ? " < > |` 与控制字符（\x00–\x1f），trim；净化后为空回退 `plan`。sanitize 逻辑实现于导出纯函数 `icsFileName(title: string): string`（§1），便于单测且 UI 不重复实现。

## 3. UI 与数据流

SettingsDrawer「数据」节：

- 现有 grid-cols-2（导出 JSON / 导入 JSON）保持第一行；第二行新增 **「导出 .ics」** 按钮（`variant="outline"`，`CalendarDays` lucide 图标，`className="col-span-2 w-full"`）。
- 点击 `exportIcs()`：
  1. `state.blocks.length === 0` → `toast.error('当前计划没有任务块，无法导出日历')`，不下载。
  2. `buildIcs(state)` → `new Blob([text], { type: 'text/calendar;charset=utf-8' })` → 下载 `icsFileName(state.plan.title)` → revoke → `toast.success('已导出日历文件（.ics）')`。
- 草稿计划（plan.id=null）同样可导出——本地状态即数据源，与 JSON 导出一致。
- streaming 不禁用导出（只读本地状态，无服务端交互）。

## 4. 错误处理

- buildIcs 为纯函数，输入由 zod/引擎保证合法，无失败路径；不新增 try/catch。
- 下载被浏览器拦截的风险与现有 JSON 导出等同，不额外处理。
- 无服务端错误码、无配额消耗、无诊断 ID 需求。

## 5. 测试策略

- **`lib/__tests__/ics.test.ts`**（vitest node，纯函数）：
  1. golden path：2 块计划 → 逐行断言完整日历文本（外壳 + 2 VEVENT + CRLF）。
  2. TEXT 转义：标题/notes 含 `, ; \` 与换行 → SUMMARY/DESCRIPTION 正确转义。
  3. 折行：长中文标题（UTF-8 多字节）→ 每行 ≤75 字节、续行前导空格、不切断字符、拼接还原原文。
  4. UID 确定性：同 block.id 两次调用 UID 相同；DTSTAMP 用注入 now 断言。
  5. UTC basic：DTSTART/DTEND 形如 `20261116T140000Z`（含毫秒 ISO 输入）。
  6. notes 空/undefined → 无 DESCRIPTION 行；非空 → 有。
  7. X-WR-CALNAME 转义 + 空标题回退 plan。
  8. 0 blocks → 合法空日历（BEGIN/END VCALENDAR，无 VEVENT）。
  9. icsFileName：非法字符去除、空/全非法回退 plan、正常标题保留中文。
- 前端接线：spec §5 惯例豁免组件单测（node 无 jsdom），tsc/build + 浏览器实测：设置抽屉导出 .ics → 下载文件文本含 VEVENT/UID/UTC → 空计划提示不下载。系统日历真实导入为可选人工验证（本地 fixture 即可产出文件）。
- 门禁：`npx vitest run` 全绿（249 + 新增）+ `npm run check:function` + `npm run build`。

## 6. 安全与约束

- 零 PAT 接触、零身份链路改动、零引擎改动、零新依赖、零后端写入。
- 导出内容 = 用户自己的计划数据，浏览器本地生成下载，不经服务端、不上传。
- 不发布：live 验收与迁移应用仍待新的点名发布授权（沿用 D 撤回状态）。
- `.Guidy.qoder.site` 平台再生成文件继续排除提交。

## 7. 范围外

图片/PNG 导出、RRULE、VALARM、多计划批量导出、/api/export 端点、Storage、ics npm 包、JSON 导出改动。