# Guidy 卡片与日历改造验收

范围：用户2026-10-13指定的卡片式端到端主流程、2026-10-16要求的每日具体时段卡片，以及旧流程/旧计划清理。本页不把完整V0.1通知/反馈/发布等后续里程碑混作已完成。

## 需求与当前证据

| 用户要求 | 当前实现与可核验来源 | 验证范围与边界 |
| --- | --- | --- |
| 点击Guidy！进入整页Agent问题卡，输入后箭头下一题 | [GuidyCards](../apps/mobile/src/components/GuidyCards.tsx)、[新目标](../apps/mobile/app/goal/new.tsx) | 已从新建目标真实走完三题与制订的浏览器/云端链路；最新iPhone端到端体验尚未验证 |
| 至少询问三个不同核心信息，允许中止或继续问答 | [chat-capture测试](../backend/tests/chat-capture.test.mjs)的stop/unknown/delegated用例；卡片按asked_topics解锁开始制订 | 真实三题后可携第三题回答直接制订；不把主题数当调用额度，停止/未知/policy边界另有测试 |
| 不强迫用户手填slots/具体日期，让Agent顺着安排 | [自动排程](../backend/src/scheduling/chat.ts)、[卡片](../apps/mobile/src/components/GuidyCards.tsx) | 未知时间采用披露假设的候选，确定性避让已有占用；确认前不入历 |
| 回看自己的回答并滑动卡片 | [QuestionHistory](../apps/mobile/src/components/QuestionHistory.tsx)、[历史测试](../backend/tests/question-history.test.mjs) | 分页遍历超过30轮、owner隔离、未回答与失败输入有覆盖；原生滑动/VoiceOver待验 |
| 搜索/研究/生成自动后台工作流，普通用户不见来源操作按钮 | [planning-jobs测试](../backend/tests/planning-jobs.test.mjs)、[Workflow](../backend/src/research/workflow.ts) | 自动研究判断/豆包搜索/冻结上下文/输出校验/恢复；unknown不自动重复付费 |
| 日历选择具体日期，看起止时间和做法卡片，只展示激活时段 | [DailyAgenda](../apps/mobile/src/components/DailyAgenda.tsx)、[时间展开](../apps/mobile/src/goals/daily-agenda.ts)、[日历接口](../backend/src/scheduling/calendar.ts) | AI新方案生成1–3步且总分钟一致；系统计算钟点；当前活动版本scheduled投影；旧无分步方案按原任务显示，不伪造解析 |
| 确认方案后自动加入日历，之后可追加修改 | [approval测试](../backend/tests/approval.test.mjs)、[content-replan测试](../backend/tests/content-replan.test.mjs) | 明确确认写不可变版本；重规划只替换未来待执行，完成/跳过/旧版本保持；模型不直接写核心表 |
| 页面简洁、黑白美化、三Tab和正式品牌不变 | [UI设计](UI_DESIGN.md)、[设计系统](../design/DESIGN_SYSTEM.md)、[参考原型](../design/prototypes/index.html) | 现有截图已核对每日卡片/浅深色图标；本轮清理不改变视觉。320窄屏浏览器不等于iPhone大字体/键盘验收 |
| 删除不再需要的旧功能 | [退役路由测试](../backend/tests/retired-routes.test.mjs)及当前src模块引用审计 | 手填条件/手动来源/搜索/数值审阅路由404；旧客户端模块与专用测试实际删除。保留自动工作流所需内部事实/引用校验与历史数据，不按文件名盲删 |
| 删除原有生成的计划数据 | [固定截止迁移](../backend/migrations/0018_clear_old_generated_plans.sql)、[只读审计脚本](../backend/scripts/plan-reset-audit.mjs)、[reset测试](../backend/tests/plan-reset.test.mjs) | 仅清理既定截止之前生成数据；保留问答/事实/预算和后来新方案。云端汇总审计见[TODO](TODO.md)对应实际轮次，不每轮重复删除 |

## 尚未满足最终验收的证据

- 最新完整流程在iPhone上的键盘、自动定位、前后台恢复、滑动与VoiceOver/大字体仍未完整验证。浏览器渲染、单元与iOS导出无法证明这些原生行为。
- 旧无分步方案不会在读取日期时偷偷调用AI或改写已批准记录；若希望获得新的细分，明确继续问答重新制订并再次确认。
- 原型中的部分历史管理工作台已被用户明确指定的新卡片流程取代；品牌/三Tab保持。完整V0.1通知/反馈闭环及App Store发布不在本页完成声明之内。

每轮真实测试数量、命令、截图验证、云端版本、未验证项及提交在[任务清单](TODO.md)中记录。该清单用于找到证据，不以文档自述代替运行结果。


## 2026-10-16 从头实际验证与修复

使用393×852浏览器前端，经测试用传输桥连接真实开发云API（不更改部署CORS、不向浏览器暴露会话Cookie），从新建旅行韩语目标开始：真实DeepSeek三个问题→第三题含200字之后的“周三没空”限制直接开始制订→真实豆包搜索1次→真实研究判断/严格方案生成→具体时间卡片→明确确认→Reload→日历Tab日期详情→320窄屏。最终完整脚本通过，澄清3次+研究/生成2次，共5次模型调用，无真实邮件；隔离身份精确清理。该桥验证真实前后端合同及交互，不等于原生Cookie、iPhone或部署CORS验证。

这轮发现并修正：冷启动账号恢复时输入可被表单重建清空；回答/后续修订原备注截断到200/160字符；模型失败记录使原问题输入框消失。延迟真实本地会话验证恢复前不可编辑/提交、恢复后草稿保留；真实本地D1受控失败记录验证重新打开恢复原回答、再次失败仍可编辑、只明确点击时重试。模型非法输出仍被拒绝，未放宽事实来源或执行边界。最新iPhone结果待用户反馈，未据浏览器通过宣称真机完成。
