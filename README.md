# Guidy · 把目标排进日历

免登录的 AI 计划工作台：用自然语言说出目标与限制，Agent 提取时间窗口、互斥、每日上限等约束，确定性排程引擎生成个性化计划，落在可拖拽的日历面板上；支持手动编辑、AI 编辑预览，满意后可发布为社区模板供他人套用自己的约束重排。

本分支 `Guidy-Qoder` 是面向 Qoder 天池大赛的 **Qoder Sites Web 实现**（React + Vite + Tailwind + 双端共享排程引擎）。`main` 保留早期 iOS / Cloudflare 版本，两者互不影响。

## 当前进度

| 里程碑 | 范围 | 状态 |
| --- | --- | --- |
| M1 工作台骨架 | 日历拖拽编辑、8 类约束管理、重排预览、撤销重做、本地持久化、视觉系统 | ✅ 已完成 |
| M2 AI 规划闭环 | Sites 后端 + QCA SSE 对话、约束提取确认卡、生成预览与恢复 | 待启动（后端开通需确认） |
| M3 AI 编辑与身份 | Patch diff 预览/应用、多计划、恢复码、配额限流 | 规划中 |
| M4 社区与发布 | 模板发布/脱敏/广场/套用、公开访问 | 规划中 |

里程碑定义与退出标准见 [docs/PRD.md](docs/PRD.md) §9 与 [docs/测试与验收用例.md](docs/测试与验收用例.md) §11。

## 快速开始

```sh
npm ci
npm run dev      # 本地预览（loopback URL 见终端输出）
npm test         # 引擎 + Schema 单测（Vitest）
npm run build    # tsc 校验 + 静态产物 dist/
```

M1 为纯本地工作台：数据存于浏览器 localStorage，无云资源、无模拟 AI。

## 目录

- `shared/` — 双端共享：类型、Zod Schema、确定性排程引擎（solve / validate / diff / hash）
- `components/calendar/` — 自研日历面板（CSS Grid + Pointer Events，拖拽/缩放/键盘/预览 ghost）
- `components/workbench/` — 概览、约束/任务/块/设置抽屉、顶栏
- `store/` — zustand 状态（计划、撤销栈、预览、UI）
- `lib/` — 示例计划、持久化、外观偏好、约束文案
- `functions/` — Sites Edge Function（M2 起启用）
- `docs/` — PRD、技术方案、数据模型与 API 契约、UI/UX 设计规范、测试与验收用例

## 设计

视觉方向「晨光时间轴」：黎明渐变品牌时刻 + 8 类别色板；外观/圆角/间距/字号/动效通过 `--site-*` 变量实时可调，设计注册见 `.Guidy.qoder.site`。