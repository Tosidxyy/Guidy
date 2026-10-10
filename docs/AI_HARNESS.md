# Guidy AI harness · 澄清测试链路

用户于 2026-10-10 指定先使用自己的 DeepSeek API，主要开发 harness。当前 Provider 为 DeepSeek 的 `deepseek-flash`，使用 [官方 Chat Completions 接口](https://api-docs.deepseek.com/api/create-chat-completion/)，非流式、thinking disabled、JSON object；Provider 可替换，业务控制不交给模型。

## 模块与边界

| 层 | 职责 |
| --- | --- |
| agent/provider.ts | 固定 HTTPS endpoint、服务端 Key、请求/响应大小与输出 Token 限制、AbortSignal、安全错误映射；不导入 DB、不执行 tools |
| agent/harness.ts | 已验证 owner、草稿状态、目标/对话版本、上下文一致快照、运行状态、幂等/并发/调用额度、Schema 与语义边界、过期恢复 |
| D1 agent_runs | 原始请求、turn index、目标版本、私有上下文快照、requested model、context schema/harness version、usage、成功/失败/lease |
| D1 agent_messages | 关联运行的用户消息与已通过校验的回复；同一 run/role 唯一、同 Goal 复合外键、随目标删除级联 |
| Goal 内对话页 | 展示建议/系统边界，输入、失败保留、恢复/状态读取；账号/目标切换不复用私有输入 |

AI 只输出一个澄清问题和简短理由，不能写 goal_slots、PlanVersion、Calendar 或通知，也不提供 tools 列表。已确认条件由用户在条件页修改；对话回答只是对话，不自动变成确认 Slot。

## 运行协议

`GET /api/v1/goals/{id}/messages` 返回当前目标与最近 30 轮状态；原始更早记录保留在 D1。`POST` 携带 Idempotency-Key 与 `{text,expected_chat_revision,expected_goal_revision}`，text 为 1–600 字。先原子占用一轮并保存用户消息，再调用 Provider。相同请求只尝试一次 Provider；running 重放为 202，已结束重放返回持久状态，不重复付费调用。

每个 Goal 最多一个 running，turn index 防止旧页面抢占新对话；输入的目标版本必须匹配。上下文仅包含当前目标、三项条件、最近两轮成功对话和当前输入（最多 5000 字符）；不自动加入账号邮箱/ID、认证 cookie、Key 或其他目标。生成前读取一致快照，生成后再次核对目标状态/版本；已改变时拒绝旧回复，不覆盖核心数据。

模型输出必须通过 JSON、字段/类型/长度、单问和重复问题边界校验；不允许 tool calls、截断或虚假“已写入/购买”等执行声明。未通过的原始模型输出/思考内容不保存、不展示；失败输入和安全错误码仍可恢复。按明确用户事实保守匹配部分高风险条件，返回标为 policy 的系统边界，不假装这是模型输出；该词匹配不是完整医学风险判定，研究/计划尚未开放。

## 测试限额与恢复

- DeepSeek 输出最多 350 Token，HTTP/harness 等待最多 20 秒，运行 lease 45 秒，App 等待最多 30 秒。
- 每账号每天最多 8 次、全局每天最多 20 次新请求，包含失败尝试；重复同键不重复计入。按 UTC 日期重置，即北京时间每日 08:00。此为请求数量上限，不是金额预算。
- 历史/GET 只读取和结算过期状态，不自动重启模型。超时/崩溃后保留失败状态与输入，由用户明确开启新请求；中止等待不保证供应商未消耗 Token。
- 本轮是短澄清请求，不是后台长时研究 Job；不承诺关闭 App 后继续研究。agent_jobs、搜索与持久后台编排后续单独实现。

## 密钥与开关

```powershell
cd C:\Users\29035\Desktop\Guidy\backend
npx wrangler secret put DEEPSEEK_API_KEY --config wrangler.cloud.json
```

云配置 GUIDY_AI_ENABLED=true、GUIDY_AI_MODEL=deepseek-flash。部署 guard 只捕获核对 secret 名称，不显示值；本地无 Key 时 POST 为 AI_NOT_CONFIGURED，仍可读对话。需要本地真实测试时只在忽略的 backend/.dev.vars 配置同名 Key/开关，不放 App .env 或 Git。

测试方式：真实临时 D1 + 模拟 Provider 验证 harness；受控 API 回复验证 UI。真实 DeepSeek 质量与 iPhone 输入/多轮恢复必须另外验收，不能将固定测试回复当成真正模型输出。
