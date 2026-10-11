# 豆包搜索接入与首批接口

首批实现日期：2026-10-11。现有Cloudflare后端新增搜索Adapter、私人尝试/结果快照与预算保留；已接Goal内主动搜索入口；自动生成查询、PlanDraft及搜索Workflow尚未实现。页面里的旧来源重读仍是网页GET；独立搜索页由用户主动提交搜索API。

## 配置

在火山引擎联网搜索控制台创建 **Custom版web搜索** API Key，订阅和按量Key不可混用；不要使用Ark模型Key或IAM AK/SK。本轮使用[官方API](https://docs.volcengine.com/docs/87772/2272953)固定地址及Bearer认证，没有购买套餐或假设免费额度必定可用。

云开发服务端，在项目backend目录运行：

```powershell
npx wrangler secret put DOUBAO_SEARCH_API_KEY --config wrangler.cloud.json
```

在交互提示中输入密钥，不粘贴到聊天、源码、日志或EXPO_PUBLIC变量。仅本地开发时将Key写入已忽略的backend/.dev.vars；示例文件保持空值。没有Key返回SEARCH_NOT_CONFIGURED，不占搜索额度，也不自动调用其他供应商。

## 接口合同

`GET /api/v1/goals/{goal_id}/search-runs`：要求已登录及目标owner，返回最多20个私人尝试及结果；不会启动/重启搜索。过期submitted记录转unknown，不退款或重搜。

`POST /api/v1/goals/{goal_id}/search-runs`：要求同样会话/owner、Content-Type application/json、8–128字符Idempotency-Key；请求体仅query与expected_revision。例如：

```json
{"query":"英语初学者学习方法 官方资料","expected_revision":0}
```

仅草稿、当前版本且基础条件readiness=research_preparation允许调用；历史policy提示仍阻断。query最多100个Unicode字符，拒绝邮箱、长数字串、URL及控制/不可见字符。不自动传目标原文/条件/对话/姓名；此基础格式规则不是完整个人信息分类器，接口调用者仍须提供通用去标识查询，后续自动查询需另做审阅/检查。

当前上限：每目标版本3次，账号每日6次，全局每日30次（UTC）；每次最多5条结果。成功/失败/unknown均计入保留额度。账号/全局限额通过D1 batch与最少usage记录原子占用；删除Goal清除查询/结果，但不重置当日用量；usage仅保存随机ID、owner、时间，随账号删除级联，保留清理策略待发布前实现。

供应商请求只发送通用query/web类型/固定Count与过滤设置；不携带用户Cookie/认证Headers。12秒整次等待、30秒lease、响应最多256KiB，不跟随跳转，不自动fetch结果URL。结果链接是展示数据，不代表任意URL抓取已获允许；后续URL读取另做安全校验。

统一结果含provider/request_id/searched_at和后端UUID source_id、title/url/snippet/content/content_kind/published_at。每项内容最多1200字符、标题160、snippet300；有Content标provider_content，仅Summary标provider_summary，只有Snippet标snippet_only且content为空。Snippet仅列表用途，不作为足够模型上下文。全为unverified，不造retrieved_at；搜索结果不等于事实核验。

成功201；相同键/参数已结束返回200、处理中202，不再调用；同键不同目标/版本/查询409。缺密钥503、不满足条件/版本/预算409、非法查询422；已提交供应商错误502且记录安全错误码，不返回原始错误正文。

## 费用与恢复

尝试在外部请求前持久标submitted并保留预算；进程崩溃/网络中断/超时/上游未知响应标unknown。权限/限流/额度明确失败标failed。所有记录billing_status=reserved_unknown：已知结果状态不等于已核实账单，当前未接供应商账单核对，不声称精确费用或自动退额度。

同键重放不发第二次；用户明确提交新键可在总额度内作新尝试，仍可能再次计费。没有自动重试、自动切换Provider或对unknown任务继续派发，不能照搬旧网页Workflow的GET重试。

## 验证边界与下一步

本轮测试使用合成供应商响应和真实临时D1/本地Auth边界，不证明真实Key、中文召回质量、Cloudflare外网可用性或iPhone功能。云端迁移/部署结果记[TODO](TODO.md)，密钥配置后需通过后续认证入口做真实搜索验收，不增加公网付费probe。

Goal内入口为「研究资料与来源 → 搜索研究资料」：输入默认收起，用户填写通用问题、主动提交；成功收起输入，失败保留，读取状态不自动搜索。同页恢复使用原幂等键，另开搜索需确认可能再消耗额度；重载仅读取服务端历史，不保存未提交输入。展示来源、正文不足、结果不明和旧版本。真实Cloudflare搜索及iPhone体验待用户反馈；之后加入可恢复研究编排与PlanDraft，规则及确认边界以[搜索策略](SEARCH_STRATEGY.md)和[PRD](PRD.md)为准。
