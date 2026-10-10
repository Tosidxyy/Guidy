# 研究来源准备

本轮是用户指定链接的短网页读取与私人来源存档，不是自动搜索、事实核验、后台研究 Job 或 PlanDraft。入口：目标详情 → 研究资料与来源。输入 URL、想核对的问题及可选适用限制，点击添加；关闭/重载后从账号 D1 恢复。所有资料标为 unverified，读取成功只证明得到网页片段，不证明用户问题成立、来源可信或适合该目标。

## Provider 与边界

ResearchProvider.read 与业务持久化分离。首批精确 HTTPS 域名：learnenglish.britishcouncil.org、www.nhs.uk、www.who.int、www.aad.org；不允许任意域名/IP/子域匹配、用户名密码、非默认端口或查询参数。固定白名单依赖这些官方域名及其 DNS 的可信管理，不是任意公网 URL 的 DNS/IP 校验器。外部域名扩容需再审查 SSRF 与隐私边界。

仅 GET HTML，redirect=manual、跳转拒绝；新请求不转发账号 cookie/Authorization，读取不加载网页脚本/图片/iframe。正文最多256KiB、等待10秒、只保存标题≤160和纯文本摘录≤1200字，不存完整 HTML。不执行 HTML，摘录作为普通文字显示；可能包含网页导航/不相关内容。内容始终不可信，本轮不送入 LLM，不作为系统指令或自动事实。

协议参考 [Cloudflare Request](https://developers.cloudflare.com/workers/runtime-apis/request/)。已核对的学习示例：[British Council Present simple](https://learnenglish.britishcouncil.org/free-resources/grammar/a1-a2/present-simple)。网站拒绝/超时/跳转/过大时显示失败，不伪造获取时间或摘录。

## 持久化与恢复

0008 research_evidence 保存 goal/owner复合FK、原始幂等请求、目标版本、问题、URL、用户填写限制、fetching/available/failed、unverified、访问时间和错误码。目标删除级联，不修改 Goal/Slot/Plan/Calendar。成功资料保持当次读取，不原地覆盖；旧目标版本明确提示需重新核对。当前无删除/保留期限清理接口，发布前需完成私人数据生命周期。

GET/POST /api/v1/goals/{id}/evidence 仅验证会话且本人目标。POST 需 expected_revision/Idempotency-Key、本人draft；原子占用来源记录，再进行一次有限读取。每Goal最多20条尝试，每账号每日20、全局50（UTC重置，含失败）；同Goal一条fetching，lease30秒。相同键不再次读取、运行中返回202、结束重放200；相同键不同内容409。读写结果更新前核对Goal版本，变化时失败而不保存旧摘录。POST成功201；非HTML/跳转/过大/不可用失败502。GET结算过期fetching，不自动重试；App手动读状态、填回失败来源后新键明确重试。

App等待30秒，来源表单独立底栏；未提交输入离开时提示。原始网页按钮只打开通过校验的来源，不绕过服务端读取限制来存档。更早记录不清理，测试期每Goal20条上限没有分页。

## 验证范围

真实临时D1和模拟网页覆盖并发/幂等/版本变化/owner隔离/核心表不变。Provider边界测试覆盖私网、伪域、凭据、查询、跳转、文件、过大；网页注入文字可保存为普通摘录，不控制业务。浏览器联调用受控网页片段，不冒充真实核验或模型输出。公网获取/iPhone体验须单独记录。持久后台 Job、搜索供应商、证据支撑claim核验、过期重查和计划引用后续实施。
