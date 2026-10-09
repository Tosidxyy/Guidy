# Guidy — UI Design System / 原型交付说明

> 原型版本：v0.1 · 2026-10-09  
> **静态视觉稿**，不是已实现的 iOS App、Figma 工程或已测试的代码。

## 文件清单

- `design/prototypes/00-overview.png`：六屏缩略图（可快速评审）
- `design/prototypes/01-goals.png`：目标首页（V0.1）
- `design/prototypes/02-agent-chat.png`：Agent 在具体目标内动态澄清（V0.1）
- `design/prototypes/03-plan-detail.png`：计划工作台及待确认状态（V0.1）
- `design/prototypes/04-calendar.png`：Agenda / 反馈 / 提醒待同步（V0.1）
- `design/prototypes/05-profile.png`：「我的」个人资料与二级入口（V0.1）
- `design/prototypes/06-template-detail.png`：模板详情与个性化应用设想（**V0.3 概念，非 MVP**）
- 同名 `.svg`：可导入 Figma / Illustrator / Inkscape 并编辑绝大多数图层（图标作为内嵌位图）
- `design/prototypes/index.html`：可在浏览器本地打开的离线原型图库，**不包含真实功能交互**

## 视觉规范

| 类型 | 值 / 规则 |
| --- | --- |
| 设计视口 | 393 × 852 pt，iPhone 尺寸示意；并非声称适配全部机型 |
| PNG 预览 | 786 × 1704 px（2x），RGB/RGBA 视觉稿 |
| 主色 | `#141414`（强调与主按钮）、`#FFFFFF`（卡片） |
| 背景 | `#F6F6F4` |
| 分割线 | `#E7E7E4` |
| 次级文字 | `#777774` |
| 次级卡片 | `#F2F2EF` |
| 间距 | 8 / 12 / 16 / 24 / 32 pt |
| 卡片圆角 | 13–18 pt |
| 主按钮高度 | 50–53 pt |
| 导航 | 底部严格三项：**目标｜日历｜我的** |
| Agent | 位于目标创建/修改流程中，无独立 Tab |
| 模板 | 「我的 → 我的模板」，V0.2 私人、V0.3 公开，无独立 Tab |

## 功能边界与设计实施

1. **图片只是 UI 示意**：展示的任务、邮箱、时间、资料、文本都是虚构演示值，不是用户真实数据；“已确认”“提醒待同步”等仅供状态设计参照。
2. **首版范围**：屏幕 01–05 为 V0.1 的关键示意；屏幕 06 属于 V0.3 的未来模板概念。21 天启动期属于 V0.2，不应在首页将经过天数冒充完成率。
3. **Codex 实现顺序**：M0 实现 `goals/calendar/me` 三个 Tab 和品牌 Tokens/基本排版；Agent、计划、日历数据可先用标明为演示的数据。不得把静态稿当作 API 或已可用功能。
4. **字体/可访问性**：SVG 使用 Noto Sans CJK 作为离线导出字体，React Native 中优先使用系统字体与 Dynamic Type；不要把固定 393×852 设计稿写死成真实设备布局。保证安全区、文字缩放和 44pt 触控区域。
5. **设计稿与正式图标**：原型顶部嵌入 `assets/icons/guidy-app-icon-ios-1024.png` 的缩小版本；源文件与 Expo 官方 icon 保持不变。
6. **修改原则**：PRD / 架构文档优先于示意图中的占位内容。改动影响产品范围或导航，先确认再写代码。

## 已知限制

- 原型非 Figma 云端链接，也不是 App 的可运行代码。
- `index.html` 用于查看六屏；点击图可打开 SVG，无法模拟任务交互。
- 页面中状态栏、顶部返回等为视觉元素；正式 iOS 应使用 Expo Router / Safe Area 及系统状态栏能力。
- 深色模式、键盘交互、VoiceOver、动画与通知权限弹窗尚未提供单独设计稿，必须开发时补充并真机验证。
