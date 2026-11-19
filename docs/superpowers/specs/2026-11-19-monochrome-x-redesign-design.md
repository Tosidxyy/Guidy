# Guidy 全站黑白升级（X 美术风格）设计 spec

日期：2026-11-19 · 状态：待用户审阅 · 路径：brainstorming architectural

## 1. 背景与目标

现状视觉为「晨光时间轴」：暖纸底 + 黎明渐变（#FFB86B→#FF7E5F→#6A5AE0）+ 8 类别彩色。用户要求全站大升级：

- 图标换 `mobile-legacy` 分支的黑白正式符号（母版规则：不重绘、不加元素、不改黑白方案）。
- 整个 UI 以黑白色系为主，参考 X（原推特）美术风格。
- 必须有高级感、流畅动效、拒绝 AI 感（无渐变 hero、无紫橙渐变、无空洞装饰）。

已确认决策（用户三问三答）：

1. **极性**：明暗两套纯黑白主题都做，默认跟随系统 `prefers-color-scheme`。
2. **类别区分**：8 类 = 每主题 8 档灰阶 + 现有 lucide 图标 + 文字标签；选中/悬停用描边提亮。不保留类别彩色。
3. **动效 personality**：克制精准（X 式 120–200ms ease-out 微交互 + 短 stagger），尊重 `prefers-reduced-motion`。

执行方案：令牌层重写 + 组件一次性 sweep（方案 A）。否掉新旧主题并行（维护翻倍）与逐组件渐进（中间态不一致）。

## 2. 品牌资产

- 从 `mobile-legacy` 原样提取（`git show mobile-legacy:assets/icons/<file>`）：
  - `guidy-symbol-black-transparent.png` → `public/brand/symbol-black.png`
  - `guidy-symbol-white-transparent.png` → `public/brand/symbol-white.png`
- `LogoMark` 改为 CSS mask 单资产方案：`mask-image: url(/brand/symbol-black.png)` + `background-color: var(--site-fg)`，随主题自动反色；尺寸 prop 保留。禁止重绘矢量近似。
- favicon：`index.html` 双 `<link rel="icon" type="image/png" media="(prefers-color-scheme: light|dark)">` 指向黑/白符号；删除 dawn `favicon.svg` 引用（文件保留或删除见 §6）。
- 字标 "Guidy"：`font-display` 700、tracking -0.02em。
- iOS 母版与启动屏资产留在 legacy 分支，不复制进 Web。
- `EmptyCalendar` 插画改为 legacy 符号大尺寸灰 mask（`--site-muted` 色）。

## 3. 设计令牌（globals.css 重写 :root 与 .dark）

### 3.1 表面与文字（X 取值）

| token | light | dark |
| --- | --- | --- |
| --site-bg | #ffffff | #000000 |
| --site-fg | #0f1419 | #e7e9ea |
| --site-surface | #ffffff | #000000 |
| --site-surface-2 | #f7f9f9 | #16181c |
| --site-muted / --site-ink-soft | #536471 | #71767b |
| --site-border / --site-line | #eff3f4 | #2f3336 |
| --site-line-soft | #f7f9f9 | #16181c |
| --site-accent | #0f1419 | #e7e9ea |
| --site-on-accent | #ffffff | #000000 |
| --site-scrim | rgba(15,20,25,.45) | rgba(0,0,0,.6) |

主按钮 = 反色平面（fg 底 + on-accent 字）pill；次按钮 = 发丝边框平面。无渐变。

### 3.2 类别灰阶（--site-cat-*，顺序 study/fitness/reading/work/life/creative/rest/other）

- dark：#f5f8fa #dbe0e3 #c1c7cb #a7aeb3 #8d949a #737a80 #596066 #3f464c
- light：#0f1419 #292f33 #43494d #5c6367 #757c81 #8e959a #a7aeb3 #c0c7cb

块视觉：3px 左描边 = 类别灰阶；填充 = color-mix(类别 14%, surface)；文字 = --site-fg；图标常显（compact 时仅图标+标题）。选中 = 描边提亮至 fg + 1px outline；悬停 = 填充比例 18%。

`shared/constants.ts` CATEGORIES.color 改为 light 灰阶值（仅作非 CSS 上下文 fallback）；`categoryColor(key)` 改返回 `var(--site-cat-${key})`。引擎不消费颜色，零引擎改动。

### 3.3 语义与功能色（仅功能态，"黑白为主"允许）

- --site-danger #f4212e（X 红）、--site-success #00ba7c（X 绿）、--site-warning light #946300 / dark #ffd400（仅校验提示与 toast 图标）。
- NowLine：单色 = var(--site-fg)，时间 chip 反色；删除珊瑚色与脉冲。
- busy 斜纹：灰阶 6–8% 透明度；active-window 底色：surface-2 40%。

### 3.4 删除

`--site-dawn`、`--site-dawn-soft`、`--site-dawn-line`、`--site-brand`（全部引用点改 `--site-accent`：focus outline、--ring、sidebar-primary 等）、utilities `.dawn-gradient` / `.dawn-text`、所有 dawn 引用点（倒计时数字改 fg tabular 加粗、示例横幅改 surface-2 平面、ConfirmGenerateButton 改反色 pill、QuestionCard 顶部渐变条改发丝边框）。

### 3.5 Nudge 契约（不变）

`--site-bg/fg/accent/on-accent/surface/muted/border/font/radius/space/type/motion` 全部继续被业务样式消费；radius 默认 16（卡片）、按钮 pill 为有意圆角单独保留；workbench `.Guidy.qoder.site` 能力声明不变（appearance/radius/spacing/typography/motion）。

## 4. 字体与排版

- 标题：Space Grotesk 700，tracking -0.02em；数字 tabular。
- 正文：Inter 400/500；基准 14–15px；muted 用于辅助行。
- 发丝边框 1px（--site-line）；卡片 radius var(--site-radius)（默认 16）；按钮 rounded-full。
- 留白：面板 padding 16px；节间 12–16px；日历 gutter 标签 muted 11px。

## 5. 动效（克制精准）

- 令牌：--site-motion-quick 120ms / standard 180ms / slow 240ms；ease glide cubic-bezier(0.16,1,0.3,1)；snap 缓动仅保留给拖拽落位 settle。
- 微交互：hover 边框→fg/40 + 填充提亮 120ms；press active:scale(0.98)；focus-visible 2px fg outline。
- 入场：列表/卡片 stagger 24ms × ≤8 项，fade+translateY(4px) 240ms；sheet/dialog 滑入 180ms。
- 主题切换：html 上 background-color/color 160ms ease-out crossfade。
- 删除：breathe/shimmer 循环除 skeleton 外全部；NowLine 脉冲；dawn  shimmer。
- 拖拽：跟手直写 transform 不变（零延迟）；落位 settle 180ms snap。
- `prefers-reduced-motion: reduce` 全局 0.01ms 保留。

## 6. 组件 sweep 清单

TopBar（mask logo、pill 视图 tabs、发丝分隔）、OverviewPanel（平面统计卡、单色倒计时、约束行发丝）、CalendarPanel（网格发丝、busy/active 灰底、单色 NowLine、footer）、BlockCard（灰阶 var、图标常显、选中提亮）、BlockDrawer/TasksDrawer/ConstraintDrawer/SettingsDrawer（发丝 header、平面行）、QuestionCard（发丝顶条、pill chips 单色、自定义 chip 虚线保留）、PlanCardPanel/ConstraintSetBody（平面卡、反色确认按钮）、Button/sonner toast（单色 richColors 改语义仅图标色）、EmptyCalendar（符号 mask）、index.html（meta theme-color 双值、favicon 双 link、title 不变）。
删除 `public/favicon.svg`（被双 png link 取代）。

## 7. 范围外

引擎/后端/prompt/数据模型零改动；M2/M3/M4 功能不动；legacy 分支资产除两个透明符号外不复制；不新增字体依赖。

## 8. 验证

- 452 vitest + tsc + build 全绿（constants 颜色改动若触发断言则同步更新断言）。
- 截图四组：桌面 1440×900 / 移动 390×844 × 明/暗，人工核验：纯黑白无渐变残留、灰阶类别可辨、发丝边框、高级感。
- 浏览器交互回归：拖拽移动/缩放、抽屉编辑、追问卡 chips+自定义、重排+撤销、主题切换 crossfade。
- reduced-motion 抽查（emulate media）确认循环动效关闭。
- workbench Nudge：设置抽屉滑杆实时生效复核（变量消费不变）。

## 9. 风险

- 灰阶深档在纯黑底对比偏弱 → 图标+文字兜底；截图核验若不可辨则上调深档亮度。
- mask 方案 Safari 兼容：-webkit-mask-image 双写。
- 用户 localStorage 旧 prefs（radius 10）会覆盖新默认 16 → 迁移：prefs 版本键 v2，旧值半径重置为默认（其余保留）。