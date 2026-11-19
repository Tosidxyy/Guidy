# Guidy 全站黑白 X 风格升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Guidy Web 全站视觉从「晨光渐变」换成 X 式纯黑白高级感：legacy 黑白符号、双纯黑白主题（跟随系统）、灰阶类别、克制精准动效。

**Architecture:** 令牌层（src/globals.css）一次性重写为 X 取值双主题 + 8 档灰阶类别 var；品牌资产用 mobile-legacy 透明符号经 CSS mask 单资产反色；组件层按精确字符串 sweep 删除 dawn/brand 硬编码；动效令牌重调 + stagger/press/crossfade 微交互。引擎/后端/prompt 零改动。

**Tech Stack:** React 19 + Vite 8 + Tailwind 4（@theme inline 令牌桥）+ shadcn/ui + zustand + vitest。

**Spec:** `docs/superpowers/specs/2026-11-19-monochrome-x-redesign-design.md`

## Global Constraints

- 明暗两套纯黑白主题，默认跟随系统 `prefers-color-scheme`；light：bg #ffffff / fg #0f1419 / surface-2 #f7f9f9 / border #eff3f4 / muted #536471；dark：bg #000000 / fg #e7e9ea / surface-2 #16181c / border #2f3336 / muted #71767b。
- 类别灰阶顺序 study/fitness/reading/work/life/creative/rest/other：dark `#f5f8fa #dbe0e3 #c1c7cb #a7aeb3 #8d949a #737a80 #596066 #3f464c`；light `#0f1419 #292f33 #43494d #5c6367 #757c81 #8e959a #a7aeb3 #c0c7cb`。
- 语义色仅功能态：danger #f4212e、success #00ba7c、warning light #946300 / dark #ffd400。
- 动效：quick 120ms / standard 180ms / slow 240ms（均 × var(--site-motion)）；ease glide cubic-bezier(0.16,1,0.3,1)；stagger 24ms×≤8；press scale(0.98)；主题 crossfade 160ms；`prefers-reduced-motion: reduce` 全局 0.01ms 保留。
- 图标母版规则：不重绘、不加元素、不改黑白方案；仅提取 `guidy-symbol-{black,white}-transparent.png`。
- Nudge 契约不变：`--site-bg/fg/accent/on-accent/surface/muted/border/font/radius/space/type/motion` 继续被消费；radius 默认 16px；`.Guidy.qoder.site` 能力声明不动。
- 引擎（shared/engine）、后端（functions）、prompt 零改动；CATEGORIES.color 仅改 hex 值（fallback），`categoryColor()` 改返回 CSS var。
- 每个 Task 结束 commit；commit 身份用 `-c user.name="Yuyang Xia" -c user.email="110105540+Tosidxyy@users.noreply.github.com"`（不改 git config）。
- 验证命令：`npx vitest run`、`npx tsc --noEmit`、`npm run build`。

## File Structure

- `public/brand/symbol-black.png` / `symbol-white.png`（Create，git 提取）— 唯一品牌符号资产。
- `components/brand/Logo.tsx`（Modify）— mask 单资产 LogoMark + 紧排字标。
- `components/brand/EmptyCalendar.tsx`（Modify）— 符号 mask 空态。
- `index.html`（Modify）— 双 favicon link + 双 theme-color meta。
- `public/favicon.svg`（Delete）。
- `src/globals.css`（Modify）— 令牌/映射/utilities/base/动效全重写。
- `shared/constants.ts`（Modify）— CATEGORIES.color → light 灰阶。
- `lib/describe.ts`（Modify）— categoryColor → var。
- `lib/prefs.ts`（Modify）— prefs v2 迁移（半径重置 16）。
- `lib/__tests__/mono.test.ts`（Create）— categoryColor + prefs 迁移测试。
- `components/calendar/BlockCard.tsx`、`CalendarPanel.tsx`、`ConflictBar.tsx`（Modify）— 日历单色化。
- `components/workbench/{TopBar,OverviewPanel,BlockDrawer,TasksDrawer,ConstraintDrawer,SettingsDrawer,PlansDrawer}.tsx`、`src/App.tsx`（Modify）— 工作台 sweep。
- `components/chat/{ArtifactGenerating,ChatInput,ChatPanel,PlanCardPanel,MessageBubble,QuestionCard,ConstraintSetBody}.tsx`、`components/ui/button.tsx`（Modify）— 对话面 sweep + pill/press。
- `docs/superpowers/plans/2026-11-19-monochrome-x-redesign.md`（本文件）。

---

### Task 1: 品牌资产与 Logo / favicon / 空态

**Files:**
- Create: `public/brand/symbol-black.png`, `public/brand/symbol-white.png`
- Modify: `components/brand/Logo.tsx`, `components/brand/EmptyCalendar.tsx`, `index.html`
- Delete: `public/favicon.svg`

**Interfaces:**
- Produces: `LogoMark({size?: number})`（mask span，颜色自动 = var(--site-fg)）；`Logo({compact?: boolean})`；`EmptyCalendar({className?: string})`；静态资产路径 `/brand/symbol-black.png`、`/brand/symbol-white.png`（Task 3/4 的 mask 引用同路径）。

- [ ] **Step 1: 提取 legacy 符号（原样字节）**

```bash
mkdir -p public/brand
git show mobile-legacy:assets/icons/guidy-symbol-black-transparent.png > public/brand/symbol-black.png
git show mobile-legacy:assets/icons/guidy-symbol-white-transparent.png > public/brand/symbol-white.png
ls -la public/brand/
```

Expected: 两个非空 PNG。

- [ ] **Step 2: 重写 Logo.tsx**

```tsx
import type { CSSProperties } from 'react';

const MASK: CSSProperties = {
  maskImage: 'url(/brand/symbol-black.png)',
  maskSize: 'contain',
  maskRepeat: 'no-repeat',
  maskPosition: 'center',
  WebkitMaskImage: 'url(/brand/symbol-black.png)',
  WebkitMaskSize: 'contain',
  WebkitMaskRepeat: 'no-repeat',
  WebkitMaskPosition: 'center',
};

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="block shrink-0"
      style={{ width: size, height: size, backgroundColor: 'var(--site-fg)', ...MASK }}
    />
  );
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 select-none">
      <LogoMark />
      {!compact && (
        <span className="font-display text-lg font-bold tracking-[-0.02em] text-site-ink">
          Guidy
        </span>
      )}
    </span>
  );
}
```

（整文件替换，删除旧 svg/gradient 代码。）

- [ ] **Step 3: 重写 EmptyCalendar.tsx**

```tsx
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

const MASK: CSSProperties = {
  maskImage: 'url(/brand/symbol-black.png)',
  maskSize: 'contain',
  maskRepeat: 'no-repeat',
  maskPosition: 'center',
  WebkitMaskImage: 'url(/brand/symbol-black.png)',
  WebkitMaskSize: 'contain',
  WebkitMaskRepeat: 'no-repeat',
  WebkitMaskPosition: 'center',
};

export function EmptyCalendar({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-col items-center gap-4', className)} aria-hidden="true">
      <span className="block h-24 w-24 opacity-40" style={{ backgroundColor: 'var(--site-muted)', ...MASK }} />
      <span className="h-px w-40 bg-site-line" />
    </div>
  );
}
```

（保留原文件的 props 签名兼容：原为 `{ className?: string }`，一致。删除旧 svg。）

- [ ] **Step 4: index.html 头部替换**

old:
```html
    <meta name="theme-color" content="#f7f5f0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
```
new:
```html
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)" />
    <link rel="icon" type="image/png" href="/brand/symbol-black.png" media="(prefers-color-scheme: light)" />
    <link rel="icon" type="image/png" href="/brand/symbol-white.png" media="(prefers-color-scheme: dark)" />
```

- [ ] **Step 5: 删除旧 favicon 并验证构建**

```bash
rm public/favicon.svg
npx tsc --noEmit && npm run build 2>&1 | tail -3
```
Expected: TSC 无输出、build ✓ built。

- [ ] **Step 6: Commit**

```bash
git add public/brand components/brand/Logo.tsx components/brand/EmptyCalendar.tsx index.html
git rm --cached public/favicon.svg 2>/dev/null; git add -u public/favicon.svg
git -c user.name="Yuyang Xia" -c user.email="110105540+Tosidxyy@users.noreply.github.com" commit -m "feat(brand): legacy monochrome symbol via CSS mask, dual favicon/theme-color"
```

---

### Task 2: 令牌重写 + 类别 var + prefs 迁移（TDD）

**Files:**
- Modify: `src/globals.css`, `shared/constants.ts:3-12`, `lib/describe.ts:10-12`, `lib/prefs.ts`
- Create: `lib/__tests__/mono.test.ts`

**Interfaces:**
- Produces: `categoryColor(key: string): string` 返回 `var(--site-cat-<key>)`（未知 key → `var(--site-cat-other)`）；`loadPrefs(): GuidyPrefs`（v2 键 `guidy.prefs.v2`，v1 迁移半径重置 16）；CSS var `--site-cat-*` 双主题、`--site-motion-quick/standard/slow` = 120/180/240ms。
- Consumes: Task 1 的 `/brand/symbol-black.png`（无关本 task，仅顺序）。

- [ ] **Step 1: 写失败测试**

```ts
// lib/__tests__/mono.test.ts
import { describe, expect, it } from 'vitest';
import { categoryColor } from '@/lib/describe';
import { loadPrefs, DEFAULT_PREFS } from '@/lib/prefs';

describe('monochrome tokens', () => {
  it('categoryColor 返回主题灰阶 var', () => {
    expect(categoryColor('study')).toBe('var(--site-cat-study)');
    expect(categoryColor('nope')).toBe('var(--site-cat-other)');
  });
  it('prefs v1 迁移：半径重置默认，其余保留', () => {
    localStorage.setItem('guidy.prefs.v1', JSON.stringify({ radius: 4, space: 1.1, type: 0.95, motion: 0 }));
    const p = loadPrefs();
    expect(p.radius).toBe(DEFAULT_PREFS.radius);
    expect(p.space).toBe(1.1);
    expect(p.type).toBe(0.95);
    expect(p.motion).toBe(0);
    expect(localStorage.getItem('guidy.prefs.v2')).toBeTruthy();
  });
  it('prefs v2 优先', () => {
    localStorage.setItem('guidy.prefs.v2', JSON.stringify({ radius: 8, space: 1, type: 1, motion: 1 }));
    expect(loadPrefs().radius).toBe(8);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run lib/__tests__/mono.test.ts`
Expected: FAIL（categoryColor 返回 hex；loadPrefs 读 v1 半径 4）。

- [ ] **Step 3: 实现 categoryColor 与 prefs 迁移**

`lib/describe.ts` old:
```ts
export function categoryColor(key: string): string {
  return CATEGORY_MAP[key]?.color ?? '#8C7A6B';
}
```
new:
```ts
export function categoryColor(key: string): string {
  return CATEGORY_MAP[key] ? `var(--site-cat-${key})` : 'var(--site-cat-other)';
}
```

`lib/prefs.ts`：`const KEY = 'guidy.prefs.v2';` 新增 `const LEGACY_KEY = 'guidy.prefs.v1';`；`DEFAULT_PREFS.radius` 改 16；loadPrefs 改为：

```ts
export function loadPrefs(): GuidyPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<GuidyPrefs>) };
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const old = JSON.parse(legacy) as Partial<GuidyPrefs>;
      const migrated: GuidyPrefs = { ...DEFAULT_PREFS, space: old.space ?? DEFAULT_PREFS.space, type: old.type ?? DEFAULT_PREFS.type, motion: old.motion ?? DEFAULT_PREFS.motion };
      localStorage.setItem(KEY, JSON.stringify(migrated));
      localStorage.removeItem(LEGACY_KEY);
      return migrated;
    }
    return DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run lib/__tests__/mono.test.ts`
Expected: PASS 3 tests。

- [ ] **Step 5: constants 类别 hex 改 light 灰阶**

`shared/constants.ts` CATEGORIES 的 color 依次改：`#0f1419, #292f33, #43494d, #5c6367, #757c81, #8e959a, #a7aeb3, #c0c7cb`（key/label/icon 不变）。

- [ ] **Step 6: globals.css 令牌重写**

`:root {` 第一块（22-69 行）整体替换为：

```css
:root {
  --site-bg: #ffffff;
  --site-fg: #0f1419;
  --site-accent: #0f1419;
  --site-on-accent: #ffffff;
  --site-surface: #ffffff;
  --site-muted: #536471;
  --site-border: #eff3f4;
  --site-font: "Inter", "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", sans-serif;
  --site-radius: 16px;
  --site-space: 1;
  --site-type: 1;
  --site-motion: 1;

  --site-surface-2: #f7f9f9;
  --site-ink-soft: #536471;
  --site-line: #eff3f4;
  --site-line-soft: #f7f9f9;
  --site-scrim: rgba(15, 20, 25, 0.45);

  --site-success: #00ba7c;
  --site-warning: #946300;
  --site-warning-text: #946300;
  --site-danger: #f4212e;
  --site-info: #0f1419;

  --site-cat-study: #0f1419;
  --site-cat-fitness: #292f33;
  --site-cat-reading: #43494d;
  --site-cat-work: #5c6367;
  --site-cat-life: #757c81;
  --site-cat-creative: #8e959a;
  --site-cat-rest: #a7aeb3;
  --site-cat-other: #c0c7cb;

  --site-font-display: "Space Grotesk", "Inter", "PingFang SC", "Microsoft YaHei", sans-serif;
  --site-motion-quick: calc(120ms * var(--site-motion));
  --site-motion-standard: calc(180ms * var(--site-motion));
  --site-motion-slow: calc(240ms * var(--site-motion));
  --site-ease-glide: cubic-bezier(0.16, 1, 0.3, 1);
  --site-ease-snap: cubic-bezier(0.34, 1.56, 0.64, 1);
}
```

`.dark {` 块（71-87 行）整体替换为：

```css
.dark {
  --site-bg: #000000;
  --site-fg: #e7e9ea;
  --site-accent: #e7e9ea;
  --site-on-accent: #000000;
  --site-surface: #000000;
  --site-muted: #71767b;
  --site-border: #2f3336;
  --site-surface-2: #16181c;
  --site-ink-soft: #71767b;
  --site-line: #2f3336;
  --site-line-soft: #16181c;
  --site-scrim: rgba(0, 0, 0, 0.6);
  --site-warning: #ffd400;
  --site-warning-text: #ffd400;
  --site-cat-study: #f5f8fa;
  --site-cat-fitness: #dbe0e3;
  --site-cat-reading: #c1c7cb;
  --site-cat-work: #a7aeb3;
  --site-cat-life: #8d949a;
  --site-cat-creative: #737a80;
  --site-cat-rest: #596066;
  --site-cat-other: #3f464c;
}
```

映射块内：`--ring: var(--site-brand);` → `--ring: var(--site-accent);`；`--sidebar-primary: var(--site-brand);` → `var(--site-accent)`；`--sidebar-primary-foreground: var(--site-brand-ink);` → `var(--site-on-accent)`；`--sidebar-ring: var(--site-brand);` → `var(--site-accent)`；`--color-site-brand: var(--site-brand);` → `--color-site-brand: var(--site-accent);`（保留 Tailwind utility 名，视觉自动单色）。

- [ ] **Step 7: globals.css utilities/base/动效重写**

- 删除 `.dawn-gradient` 与 `.dawn-text` 两个 utility 块（286-294 行）。
- `.guidy-cursor` 块（313-323 行）替换为：

```css
.guidy-cursor {
  background: var(--site-fg);
  opacity: 1;
}
```

（删除 guidy-cursor-breathe keyframes 与对应 reduced-motion 块。）
- 删除 `--animate-guidy-breathe` 行与 `@keyframes guidy-breathe` 块。
- `::selection` 的 `background: rgba(255, 126, 95, 0.25);` → `background: color-mix(in srgb, var(--site-fg) 20%, transparent);`
- `:focus-visible` 的 `outline: 2px solid var(--site-brand);` → `outline: 2px solid var(--site-accent);`
- `button, a { transition-duration: calc(150ms * var(--site-motion)); }` → `transition-duration: var(--site-motion-quick);`
- `@theme inline` 内 `--default-transition-duration: calc(150ms * var(--site-motion));` → `calc(180ms * var(--site-motion))`。
- base layer 末尾（reduced-motion 块之前）加：

```css
  body {
    transition: background-color calc(160ms * var(--site-motion)) ease-out, color calc(160ms * var(--site-motion)) ease-out;
  }
```

- `.font-display` utility 扩为：

```css
  .font-display {
    font-family: var(--site-font-display);
    font-weight: 700;
    letter-spacing: -0.02em;
  }
```

- base layer 的 body 块加 `font-size: 15px;`（正文基准 14–15px，text-* utilities 仍逐元素覆盖）。
- utilities layer 加 stagger：

```css
  .guidy-stagger > * {
    animation: guidy-fade-up var(--site-motion-slow) var(--site-ease-glide) both;
  }
  .guidy-stagger > *:nth-child(2) { animation-delay: 24ms; }
  .guidy-stagger > *:nth-child(3) { animation-delay: 48ms; }
  .guidy-stagger > *:nth-child(4) { animation-delay: 72ms; }
  .guidy-stagger > *:nth-child(5) { animation-delay: 96ms; }
  .guidy-stagger > *:nth-child(6) { animation-delay: 120ms; }
  .guidy-stagger > *:nth-child(7) { animation-delay: 144ms; }
  .guidy-stagger > *:nth-child(8) { animation-delay: 168ms; }
```

- [ ] **Step 8: 全量验证**

Run: `npx vitest run && npx tsc --noEmit && npm run build 2>&1 | tail -3`
Expected: 455 tests pass（452+3）、TSC 干净、build ✓。（若有旧断言引用类别 hex，同步更新断言为 var 字符串。）

- [ ] **Step 9: Commit**

```bash
git add src/globals.css shared/constants.ts lib/describe.ts lib/prefs.ts lib/__tests__/mono.test.ts
git -c user.name="Yuyang Xia" -c user.email="110105540+Tosidxyy@users.noreply.github.com" commit -m "feat(design): X monochrome token system, grayscale category vars, prefs v2 migration"
```

---

### Task 3: 日历面单色化

**Files:**
- Modify: `components/calendar/BlockCard.tsx:47,55-63`, `components/calendar/CalendarPanel.tsx:408,713,717,720,750,785-787,796,812,838`, `components/calendar/ConflictBar.tsx:57`

**Interfaces:**
- Consumes: `categoryColor()`（Task 2）、`--site-cat-*`、`--site-ink` utility（= fg）。
- Produces: 单色日历视觉（灰阶块、单色 NowLine、发丝网格），供 Task 6 截图核验。

- [ ] **Step 1: BlockCard 类别 var 化**

import 加 `import { categoryColor } from '@/lib/describe';`
style 块 old:
```ts
        ['--cat' as string]: cat.color,
        background: ghost
          ? `color-mix(in srgb, ${cat.color} ${visual === 'ghost-added' ? 16 : 8}%, var(--site-surface))`
          : `color-mix(in srgb, ${cat.color} 13%, var(--site-surface))`,
        borderLeftWidth: 3,
        borderLeftColor: cat.color,
```
new:
```ts
        ['--cat' as string]: categoryColor(block.category),
        background: ghost
          ? `color-mix(in srgb, var(--cat) ${visual === 'ghost-added' ? 16 : 8}%, var(--site-surface))`
          : `color-mix(in srgb, var(--cat) var(--cat-fill, 14%), var(--site-surface))`,
        borderLeftWidth: 3,
        borderLeftColor: 'var(--cat)',
```
className 的 `'group absolute select-none overflow-hidden rounded-md border text-left'` 行追加 `hover:[--cat-fill:18%]`（悬停填充 18%，spec §3.2）。
className old: `visual === 'selected' && 'border-site-brand shadow-md ring-2 ring-site-brand/30',`
new: `visual === 'selected' && 'border-site-ink shadow-md ring-2 ring-site-ink/30',`
（`cat` 保留：图标/label 仍用 CATEGORY_MAP；仅颜色改走 categoryColor var。）

- [ ] **Step 2: CalendarPanel 精确替换**

逐条 Edit（old → new）：
1. `'2px solid var(--site-brand)'` → `'2px solid var(--site-accent)'`（408 行 outline）。
2. `isToday && 'bg-[var(--site-dawn-soft)]'` → `isToday && 'bg-site-surface-2/60'`（713 与 750 两处，allow_multiple）。
3. `isToday ? 'font-semibold text-[var(--site-dawn-line)]' : 'text-site-ink-soft'` → `isToday ? 'font-semibold text-site-ink' : 'text-site-ink-soft'`。
4. `isToday ? 'dawn-text' : 'text-site-ink'` → `isToday ? 'text-site-ink' : 'text-site-ink'`。
5. NowLine 三处 `bg-[var(--site-dawn-line)]` → `bg-site-ink`（785/786/787，allow_multiple）；787 行 chip `text-white` → `text-site-bg`。
6. `chip.ok ? (chip.soft ? 'bg-site-warning' : 'bg-site-brand') : 'bg-site-danger'` → `chip.ok ? (chip.soft ? 'bg-site-warning text-site-bg' : 'bg-site-ink text-site-bg') : 'bg-site-danger text-white'`。
7. `border-site-brand/70 bg-site-brand/10` → `border-site-ink/70 bg-site-ink/10`（812 marquee）。
8. `hidden text-site-brand sm:inline` → `hidden text-site-ink sm:inline`（838）。

- [ ] **Step 3: ConflictBar 替换**

`text-[11px] text-site-brand` → `text-[11px] text-site-ink`。

- [ ] **Step 4: 验证 + Commit**

Run: `npx tsc --noEmit && npx vitest run 2>&1 | grep -E 'Tests '`
Expected: 455 passed。

```bash
git add components/calendar
git -c user.name="Yuyang Xia" -c user.email="110105540+Tosidxyy@users.noreply.github.com" commit -m "feat(calendar): monochrome blocks, now-line and grid hairlines"
```

---

### Task 4: 工作台 sweep

**Files:**
- Modify: `components/workbench/TopBar.tsx:88`, `BlockDrawer.tsx:220`, `TasksDrawer.tsx:75`, `ConstraintDrawer.tsx:227,237`, `SettingsDrawer.tsx:129,143,236`, `PlansDrawer.tsx:55,69,72,74`, `src/App.tsx:76` + Toaster richColors

**Interfaces:**
- Consumes: `--site-ink`/`--site-line`/`--site-surface-2` utilities（Task 2）。
- Produces: 单色工作台；Task 6 截图对象。

- [ ] **Step 1: 精确替换（每文件 Edit）**

- TopBar 88: `view === v ? 'bg-site-brand text-white shadow-sm' : 'text-site-ink-soft hover:text-site-ink'` → `view === v ? 'bg-site-ink text-site-bg shadow-sm' : 'text-site-ink-soft hover:text-site-ink'`。
- BlockDrawer 220: `<Pin className="h-4 w-4 text-site-brand" />` → `text-site-ink`。
- TasksDrawer 75: `<ListChecks className="h-4 w-4 text-site-brand" />` → `text-site-ink`。
- ConstraintDrawer 227: `<ShieldCheck className="h-4 w-4 text-site-brand" />` → `text-site-ink`；237: `hover:text-site-brand` → `hover:text-site-ink`。
- SettingsDrawer 129: `<Settings2 className="h-4 w-4 text-site-brand" />` → `text-site-ink`；143: `theme === t ? 'border-site-brand bg-site-brand/10 text-site-brand' : ...` → `theme === t ? 'border-site-ink bg-site-ink/10 text-site-ink' : ...`；236: `border-site-brand/40 bg-site-brand/5` → `border-site-line bg-site-surface-2`。
- PlansDrawer 55: `<FolderOpen className="h-4 w-4 text-site-brand" />` → `text-site-ink`；69: `border-site-brand/40 bg-site-brand/5` → `border-site-line bg-site-surface-2`；72: `'border-site-brand/50 bg-site-brand/5'` → `'border-site-ink/50 bg-site-ink/5'`；74: `hover:text-site-brand` → `hover:text-site-ink`。
- App 76: `mobileTab === t.key ? 'text-site-brand' : 'text-site-ink-soft'` → `mobileTab === t.key ? 'text-site-ink' : 'text-site-ink-soft'`。
- App Toaster: 删除 `richColors` prop（单色 toast，语义仅图标色）。

- [ ] **Step 2: 卡片圆角 Nudge 化（机械替换）**

```bash
grep -rl 'rounded-xl' components src | xargs sed -i 's/rounded-xl/rounded-(--site-radius)/g'
npx tsc --noEmit
```
Expected: TSC 干净（Tailwind 4 括号语法 = var 引用）。

- [ ] **Step 3: 验证 + Commit**

Run: `npx vitest run 2>&1 | grep -E 'Tests '`
Expected: 455 passed。

```bash
git add components/workbench src/App.tsx components
git -c user.name="Yuyang Xia" -c user.email="110105540+Tosidxyy@users.noreply.github.com" commit -m "feat(workbench): monochrome surfaces, hairline rows, nudge-driven card radius"
```

---

### Task 5: 对话面 sweep + 按钮 pill/press

**Files:**
- Modify: `components/chat/{ArtifactGenerating,ChatInput,ChatPanel,PlanCardPanel,MessageBubble,QuestionCard,ConstraintSetBody}.tsx`, `components/ui/button.tsx:8,25-31`

**Interfaces:**
- Consumes: Task 2 令牌；`guidy-stagger` utility（Task 2）。
- Produces: 单色对话面 + pill 按钮 + press 微交互；Task 6 截图/交互对象。

- [ ] **Step 1: 精确替换**

- ArtifactGenerating 6: `<Sparkles className="h-3.5 w-3.5 animate-guidy-breathe text-site-brand" aria-hidden="true" />` → `<Loader2 className="h-3.5 w-3.5 animate-spin text-site-ink" aria-hidden="true" />`（import 改 Loader2）。
- ChatInput 35: `focus-within:border-site-brand` → `focus-within:border-site-ink`。
- ChatPanel 93: `<Sparkles className="h-4 w-4 text-site-brand" />` → `<MessageCircle className="h-4 w-4 text-site-ink" />`（import 改 MessageCircle，去 Sparkles）。
- PlanCardPanel 163: `text-site-brand` → `text-site-ink`；173 与 186: `border-[var(--site-dawn-line)]/40` → `border-site-line`（allow_multiple）；174: `<div className="dawn-gradient h-0.5 rounded-full" />` → `<div className="h-px bg-site-line" />`；197/214/222/226: `className="dawn-gradient text-white"` 删除该 prop（Button default variant = 反色主按钮）。
- MessageBubble 22: `border-[var(--site-dawn-line)]/30 bg-[var(--site-dawn-soft)]` → `border-site-line bg-site-surface-2`；23: `<Sparkles className="h-3.5 w-3.5 text-[var(--site-dawn-line)]" />` → `<Braces className="h-3.5 w-3.5 text-site-ink-soft" />`（import Braces）；61: `isUser ? 'bg-site-brand text-white' : ...` → `isUser ? 'bg-site-ink text-site-bg' : ...`。
- QuestionCard 44: `border-[var(--site-dawn-line)]/40` → `border-site-line`；46: `<div className="dawn-gradient mb-3 h-0.5 rounded-full" />` → `<div className="mb-3 h-px bg-site-line" />`；50: `text-site-brand` → `text-site-ink`；82/97: `'border-site-brand bg-site-brand/10 font-medium text-site-brand'` → `'border-site-ink bg-site-ink/10 font-medium text-site-ink'`（allow_multiple）；83/98: `hover:border-site-brand/50` → `hover:border-site-ink/40`（allow_multiple，spec §5 hover 边框 fg/40）；125: `className="dawn-gradient text-white"` 删除该 prop；52 行 ul `className="mt-3 space-y-3"` → `className="guidy-stagger mt-3 space-y-3"`。
- ConstraintSetBody 171: `<Button size="sm" className="dawn-gradient text-white" disabled={disabled} onClick={onClick}>` → `<Button size="sm" disabled={disabled} onClick={onClick}>`；61 行任务 ul `className="space-y-1.5"` → `className="guidy-stagger space-y-1.5"`；135 行约束 ul 同样加 `guidy-stagger`。

- [ ] **Step 2: button.tsx pill + press**

cva base（8 行）`rounded-md` → `rounded-full`，并在 `transition-all` 后加 `active:scale-[0.98]`；sizes 内所有 `rounded-md` → `rounded-full`（25-31 行）。

- [ ] **Step 3: 验证 + Commit**

Run: `npx vitest run 2>&1 | grep -E 'Tests ' && npx tsc --noEmit && npm run build 2>&1 | tail -2`
Expected: 455 passed、TSC 干净、build ✓。

```bash
git add components/chat components/ui/button.tsx
git -c user.name="Yuyang Xia" -c user.email="110105540+Tosidxyy@users.noreply.github.com" commit -m "feat(chat): monochrome conversation surfaces, pill buttons, press micro-interaction"
```

---

### Task 6: 验证与收尾

**Files:**
- Modify: 无（仅验证；发现缺陷回改对应文件并追加 commit）
- Create: `dev/mono-light.png`, `dev/mono-dark.png`, `dev/mono-mobile-light.png`, `dev/mono-mobile-dark.png`（截图，gitignore 已覆盖 dev/*.png）

**Interfaces:**
- Consumes: 全部前序 task 产物。
- Produces: 验证证据 + 最终 commit。

- [ ] **Step 1: 全量自动化**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: 455 passed / 干净 / ✓ built。

- [ ] **Step 2: 残留扫描**

```bash
grep -rn 'dawn\|FFB86B\|FF7E5F\|6A5AE0\|site-brand\b' components src shared lib --include='*.tsx' --include='*.ts' --include='*.css' | grep -v 'color-site-brand' | grep -v 'ui/chart.tsx'
```
Expected: 无输出（--color-site-brand 映射行与未启用的 starter chart catalog 除外）。

- [ ] **Step 3: 四组截图**

dev server 在跑（http://127.0.0.1:5173）。暗色用同源种子页：写 `dev/theme-seed.html` 内容 `<!doctype html><meta charset="utf-8"><script>localStorage.setItem('guidy.theme','dark');location.replace('/');</script>`，headless Edge：

```bash
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
"$EDGE" --headless=new --disable-gpu --hide-scrollbars --screenshot=dev/mono-light.png --window-size=1440,900 --virtual-time-budget=7000 http://127.0.0.1:5173/
"$EDGE" --headless=new --disable-gpu --hide-scrollbars --screenshot=dev/mono-dark.png --window-size=1440,900 --virtual-time-budget=7000 http://127.0.0.1:5173/dev/theme-seed.html
"$EDGE" --headless=new --disable-gpu --hide-scrollbars --screenshot=dev/mono-mobile-light.png --window-size=390,844 --virtual-time-budget=7000 http://127.0.0.1:5173/
"$EDGE" --headless=new --disable-gpu --hide-scrollbars --screenshot=dev/mono-mobile-dark.png --window-size=390,844 --virtual-time-budget=7000 http://127.0.0.1:5173/dev/theme-seed.html
rm dev/theme-seed.html
```

Read 四张 PNG 人工核验：纯黑白无渐变残留、灰阶类别可辨（深档不可辨则上调 dark 深档亮度并回改 Task 2 令牌）、发丝边框、mask logo 清晰、pill 按钮。

- [ ] **Step 4: 浏览器交互回归（built-in browser，临时页用完 close_page）**

清单：拖拽移动/缩放 + 校验 chip 单色；双击开抽屉编辑保存；追问卡 chips + 自定义输入 + 合并发送；任务抽屉重排 + 顶栏撤销；设置抽屉 radius/space/type 滑杆实时生效（Nudge 契约）；主题切换 crossfade 无闪白。

- [ ] **Step 5: reduced-motion 抽查**

```bash
"$EDGE" --headless=new --disable-gpu --force-prefers-reduced-motion --screenshot=dev/mono-reduced.png --window-size=1440,900 --virtual-time-budget=7000 http://127.0.0.1:5173/
```
Read 确认入场动画终态完整（无半透明残留）。

- [ ] **Step 6: 最终 commit（如有回改）**

```bash
git add -u components src shared lib
git -c user.name="Yuyang Xia" -c user.email="110105540+Tosidxyy@users.noreply.github.com" commit -m "fix(design): monochrome verification touch-ups"
```

（无回改则跳过；截图不入库。）