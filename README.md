# Guidy — Chat & Do It.

**Guidy** 是面向 iOS 的通用 AI 目标规划与执行产品。用户提出目标，Agent 在短对话中澄清必要条件、自主研究、生成有依据的可执行计划，经过确认后安排到应用内日历，通过提醒、反馈和可审阅的重规划帮助用户推进目标。未来可以将经过执行记录与审核的规划**路径**作为模板复用。

> 当前状态：**M0 基础工程开发中**。Expo 三 Tab 和 Worker 基础 API 已可用，D1 本地开发/测试迁移已应用。基础 CI 配置见 `.github/workflows/ci.yml`。登录、远程资源和通知尚未实现，用户已确认 iPhone Expo Go 基础预览可用；专项真机验收未完成。

## 产品与技术决策

- 品牌：**Guidy**；Slogan：**Chat & Do It.**
- 首发：**iOS（Windows 开发 + iPhone 真机验证）**。
- 底部导航：**目标｜日历｜我的**。Agent 属于目标流程；模板从「我的 → 我的模板」进入。
- 客户端：**React Native + Expo + TypeScript + Expo Router**。
- 后端：**Cloudflare Workers + TypeScript 领域服务**（模块化单体）。
- 数据：**Cloudflare D1 + Better Auth**，服务端进行对象级权限校验。
- 日程：**确定性规则排程 + 用户确认**，通知通过 iPhone 本地通知实现（需真实同步状态）。
- 版本：**V0.1 核心闭环；V0.2 21 天观察期/私人模板；V0.3 公开模板社区**。

## 文档导航

| 文档 | 作用 |
| --- | --- |
| [docs/PRD.md](docs/PRD.md) | 产品范围、用户旅程、规则与验收条件 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 技术选型、服务分层、Agent、调度、API |
| [docs/UI_DESIGN.md](docs/UI_DESIGN.md) | iOS 页面、导航、交互与基础视觉 |
| [docs/DATABASE.md](docs/DATABASE.md) | 概念数据结构、对象授权与原子批次策略 |
| [docs/TODO.md](docs/TODO.md) | M0–M4 里程碑和逐项任务 |
| [docs/BRAND_GUIDE.md](docs/BRAND_GUIDE.md) | Guidy 黑白标识和 UI 视觉 Token |
| [docs/DEVELOPMENT_SETUP.md](docs/DEVELOPMENT_SETUP.md) | Windows + iPhone 初始化与图标接入步骤 |
| [AGENTS.md](AGENTS.md) | 给 Codex 的项目约定及实施原则 |
| [apps/mobile/README.md](apps/mobile/README.md) | 当前前端启动、检查命令与验证边界 |
| [backend/README.md](backend/README.md) | Workers 启动、API 合同、日志与后端检查 |

## 图标资源 · 已锁定最终视觉

![Guidy 最终黑白图标](assets/icons/guidy-icon-preview-rounded-256.png)

**设计母版：用户最终亲自确认的黑色圆角背景 + 白色抽象路径箭头，禁止未经明确确认重绘、变更颜色或替换符号。**


- 正式 iOS 方形 App icon：`assets/icons/guidy-app-icon-ios-1024.png`
- 已确认设计母版（完整原图）：`assets/icons/guidy-approved-original.png`（保持原图字节不变）
- 兼容旧引用：`assets/icons/guidy-icon-source-black-white.png`（与母版相同）
- 透明黑/白符号、反白备选与主屏幕圆角预览：`assets/icons/`
- 启动页透明白色符号：`assets/icons/guidy-splash-symbol-white.png`
- Expo 接入范例：`examples/expo/`（配置和已准备的图片）
- 原始包说明中的 `archive/` 历史文件未包含在当前目录；不作为实现依据。

**注意**：正式 App icon 为完整方形黑底，不预先裁圆角；iOS 系统会处理图标蒙版。商标与上架同名检查尚未完成。

## iOS 页面原型（新增）

- [六屏总览](design/prototypes/00-overview.png) · [离线浏览图库](design/prototypes/index.html)
- [目标首页](design/prototypes/01-goals.png) · [Agent 澄清](design/prototypes/02-agent-chat.png) · [计划详情](design/prototypes/03-plan-detail.png)
- [日历与反馈](design/prototypes/04-calendar.png) · [我的](design/prototypes/05-profile.png) · [模板详情（V0.3 概念）](design/prototypes/06-template-detail.png)
- [设计体系与实现限制](design/DESIGN_SYSTEM.md)；`design/prototypes/*.svg` 为可编辑版本。

**注意：PNG/SVG 是静态页面设计稿，不是已跑通的 React Native 页面。开发时必须同时阅读 `docs/UI_DESIGN.md`，并遵守 V0.1/V0.2/V0.3 功能边界。**

## 本地启动与开发下一步

```powershell
cd apps/mobile
npm ci
npm start
```

在同一局域网的 iPhone 上使用兼容 Expo Go 扫描 Metro 二维码。Windows 无法运行 Xcode iOS 模拟器；实际手机结果必须另行记录。

从根目录运行 `npm run typecheck`、`npm run lint`；浏览器预览用 `npm run mobile:web`。详细信息见 [移动端说明](apps/mobile/README.md)。

1. 阅读 [docs/DEVELOPMENT_SETUP.md](docs/DEVELOPMENT_SETUP.md) 和 [examples/expo/README.md](examples/expo/README.md)。
2. 按 `AGENTS.md` 和 `docs/TODO.md` 继续 **M0**，下一轮接 Better Auth 与 D1 基础迁移；iPhone 验证须另行记录。
3. 在 Windows 启动 Expo 和 Wrangler，在 iPhone 上检查三个 Tab 和 `/health`。
4. **每轮小任务都遵守 `AGENTS.md` 的闭环：快速测试通过 → `git commit` 实现 → 更新 `docs/TODO.md` → 单独 `git commit` TODO → `git push` 到 [私人仓库](https://github.com/Tosidxyy/Guidy)，并反馈真实 SHA 和推送结果。**
5. M0 通过后才启动动态澄清与 Agent 研究。

## 基础 CI

[GitHub Actions](https://github.com/Tosidxyy/Guidy/actions) 在 main 的相关代码 Push、PR 和手动触发时运行：前端 `npm ci`、类型/lint/API 客户端测试；后端 `npm ci`、类型/lint/格式、边界测试与 Wrangler dry-run。Node 24.15.0 与官方 Action SHA 固定；workflow 只有 contents:read 权限，不需要服务端密钥。纯文档 Push 不重复触发。CI 不替代 iPhone 测试，依赖审计遗留项仍保留。

## 重要安全边界

不要把用户的健康数据/日历同步记录、模型密钥或 Cloudflare Token 或 Better Auth 密钥写入客户端仓库。外部检索内容与社区模板不得作为系统提示执行。任何高风险医疗/用药建议都需要单独的安全边界和人工判断。21 天仅是**启动观察期**，不是保证习惯养成的科学结论。
