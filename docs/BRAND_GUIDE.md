# Guidy｜品牌与图标规范

> 品牌基线：2026-10-09 · 开发包 v1.1；**唯一正式品牌图形为用户最后上传并确认的黑底白色抽象路径箭头**。  
> Slogan：**Chat & Do It.**

## 1. 品牌定义

**Guidy** = Guide + Buddy 的亲切联想；定位为目标的智能向导。用户通过短对话提出目标，Guidy 帮助研究、制定、安排并持续推进计划。

品牌语气：克制、清晰、可信、积极但不说教。不能声称“21 天必然养成习惯”，也不应把尚未完成的任务写成已经完成。

**推荐文案：**

- Guidy — Chat & Do It.
- 把想法变成行动。
- 告诉 Guidy 你的目标，剩下的从第一步开始。
- 今天，把目标推进一点点。

## 2. 视觉方向

- **品牌主色**：纯黑、暖白、中性灰。主 App 图标为深黑底 + 白色路径箭头。
- **图形**：抽象的“S 形道路 + 指向前方的箭头”，既保留行动感，也避免常见聊天框与机器人形象；不引入复杂卡通角色。
- **风格**：大留白、几何流线、明确对比、少装饰、无多余渐变。
- **状态色**：成功/风险提示可少量使用绿色、琥珀色和红色；它们只是 UI 语义色，不是品牌色。
- **品牌素材不要模仿 AirJelly 的标识**；仅学习其简洁程度与识别度，保留自己的原创形状。

## 3. 图标文件与用途

| 文件 | 用途 | 备注 |
| --- | --- | --- |
| `assets/icons/guidy-app-icon-ios-1024.png` | **iOS Expo 配置的唯一正式 icon** | 1024×1024、RGB、全出血方形、没有预先圆角；iOS 由系统裁切圆角 |
| `assets/icons/guidy-app-icon-inverse-1024.png` | 白底黑色备选 | 不应与正式主图标混用 |
| `assets/icons/guidy-approved-original.png` | 用户明确选定的品牌母版（像素和原始字节保留） | 带白色留边和预览圆角，仅作为设计源图 |
| `assets/icons/guidy-icon-source-black-white.png` | 旧资源路径兼容 | 内容与 approved-original 完全相同 |
| `assets/icons/guidy-splash-symbol-white.png` | 黑底启动页使用 | 透明背景白色符号，不用作 App Icon |
| `assets/icons/guidy-icon-preview-rounded-256.png` | 视觉预览 | 不应作为生产源图 |
| `assets/icons/guidy-symbol-{black,white}-transparent.png` | UI 装饰、启动页、品牌文字旁符号 | 透明底 PNG，不作为 iOS icon |
| `archive/icon-explorations/*` | 历次候选图标 | 非最终方案，勿直接装入生产 App |

当前 `guidy-app-icon-ios-1024.png` 是从用户选定原图提取**相同白色道路与箭头形状**并整理到 iOS 系统需要的完整黑色方形画布的**位图资产**，不是重新生成的 Logo；原图作为独立文件完整保存。放入 App 前请在 iPhone 真机查看 60px 级别效果；长远可由设计师基于该形状重绘可编辑矢量源，并做商标/图形近似性检查。

### 品牌锁定规则

- **唯一正式方案**：黑底白色路径箭头；不要用以前的旅人、卡通形象、蓝色版或字母版替代。
- App Icon 由用户批准设计母版衍生，**不得直接使用带白色外边距和预绘圆角的母版文件**。
- `assets/icons/guidy-app-icon-inverse-1024.png` 是反色的**非默认衍生文件**，用于设计展示；生产 iOS 默认使用黑底版本。
- 正式启动页的建议样式是深黑背景配白色路径符号，附加文字可以在应用 UI 层渲染，不嵌进图片。
- Expo 示例与资源接入见 [`../examples/expo/README.md`](../examples/expo/README.md)。

## 4. UI 颜色 Tokens（初步建议）

| Token | 浅色模式 | 深色模式 |
| --- | --- | --- |
| `background` | `#F7F7F5` | `#0D0D0D` |
| `surface` | `#FFFFFF` | `#1B1B1B` |
| `textPrimary` | `#151515` | `#F5F5F3` |
| `textSecondary` | `#686868` | `#ADADAD` |
| `primaryAction` | `#111111` | `#F3F3F1` |
| `primaryActionText` | `#FFFFFF` | `#111111` |
| `divider` | `#E5E5E3` | `#323232` |

这些是原型值，不代表已通过 WCAG 或 iOS 无障碍测试。图标、背景和状态不可仅用颜色传达信息。

## 5. 产品布局原则

- 底部导航仅三项：**目标｜日历｜我的**。
- Agent 聊天是目标内部页面；模板入口在 **我的 → 我的模板**，后续公开社区入口在我的模板内部。
- 将聊天生成的计划视为**持久、可编辑、有版本的结构化对象**，不是长篇 Markdown。
- 明确区分草稿、待确认、已生效、通知同步中/失败。

## 6. 品牌启用前检查

- 检查 Guidy 在目标发行地区的商标、App Store 同名、域名、社交账号及已有图标近似性（**目前未验证**）。
- 如果计划未来发行其他地区，核对产品名及口号的当地语言语义和可读性。
- 在 iPhone 浅色/深色主屏幕上做 60px 缩小测试；考虑 iOS tinted 模式影响。
