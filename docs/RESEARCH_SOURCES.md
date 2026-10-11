# 研究来源准备

来源准备支持用户指定链接的短网页读取、私人存档及选定来源的后台重新读取，不是自动搜索、事实核验或 PlanDraft。入口：目标详情 → 研究资料与来源。输入 URL、想核对的问题及可选适用限制，点击添加；关闭/重载后从账号 D1 恢复。所有资料均未核实，读取成功只证明得到网页片段，不证明用户问题成立、来源可信或适合该目标。

## Provider 与边界

ResearchProvider.read 与业务持久化分离。首批精确 HTTPS 域名：learnenglish.britishcouncil.org、www.nhs.uk、www.who.int、www.aad.org；不允许任意域名/IP/子域匹配、用户名密码、非默认端口或查询参数。固定白名单依赖这些官方域名及其 DNS 的可信管理，不是任意公网 URL 的 DNS/IP 校验器。外部域名扩容需再审查 SSRF 与隐私边界。

仅 GET HTML，redirect=manual、跳转拒绝；新请求不转发账号 cookie/Authorization，读取不加载网页脚本/图片/iframe。正文最多256KiB、等待10秒、只保存标题≤160和纯文本摘录≤1200字，不存完整 HTML。不执行 HTML，摘录作为普通文字显示；可能包含网页导航/不相关内容。内容始终不可信，本轮不送入 LLM，不作为系统指令或自动事实。

协议参考 [Cloudflare Request](https://developers.cloudflare.com/workers/runtime-apis/request/)。已核对的学习示例：[British Council Present simple](https://learnenglish.britishcouncil.org/free-resources/grammar/a1-a2/present-simple)。网站拒绝/超时/跳转/过大时显示失败，不伪造获取时间或摘录。

## 持久化与恢复

0008 research_evidence 保存 goal/owner复合FK、原始幂等请求、目标版本、问题、URL、用户填写限制、fetching/available/failed、unverified、访问时间和错误码。目标删除级联，不修改 Goal/Slot/Plan/Calendar。成功资料保持当次读取，不原地覆盖；旧目标版本明确提示需重新核对。当前无删除/保留期限清理接口，发布前需完成私人数据生命周期。

GET/POST /api/v1/goals/{id}/evidence 仅验证会话且本人目标。POST 需 expected_revision/Idempotency-Key、本人draft；原子占用来源记录，再进行一次有限读取。每Goal最多20条尝试，每账号每日20、全局50（UTC重置，含失败）；同Goal一条fetching，lease30秒。相同键不再次读取、运行中返回202、结束重放200；相同键不同内容409。读写结果更新前核对Goal版本，变化时失败而不保存旧摘录。POST成功201；非HTML/跳转/过大/不可用失败502。GET结算过期fetching，不自动重试；App手动读状态、填回失败来源后新键明确重试。

App等待30秒，来源表单独立底栏；未提交输入离开时提示。原始网页按钮只打开通过校验的来源，不绕过服务端读取限制来存档。更早记录不清理，测试期每Goal20条上限没有分页。

## 验证范围

真实临时D1和模拟网页覆盖并发/幂等/版本变化/owner隔离/核心表不变。Provider边界测试覆盖私网、伪域、凭据、查询、跳转、文件、过大；网页注入文字可保存为普通摘录，不控制业务。浏览器受控回复不冒充真实核验或模型输出。公网获取/iPhone体验须单独记录。自动搜索、证据支撑claim核验和计划引用后续实施。

## 2026-10-11：后台来源任务

0009 agent_jobs/research_job_items 与 Cloudflare Workflows 实现首批持久任务。POST /api/v1/goals/{id}/research-runs 携带 Idempotency-Key、expected_revision、evidence_ids（1–3个、去重、当前版本、本人目标且非fetching的来源）。D1 batch原子保存任务及来源快照，同Goal最多一个queued/running。每Goal最多20个任务、账号每日3/全局10（UTC含失败）；数据未通过所有权/版本检查不创建任务。选定来源只在用户主动提交后重新读取，不增加模型调用。

创建Workflow时使用固定任务UUID，仅传jobId；启动确认后返回202。D1与Workflow创建不是跨服务事务：启动失败保留queued/未启动记录并返回503，GET不重新派发。用户通过resume_job_id尝试启动已保存任务，仍使用同一个实例ID；相同原请求重放不会创建另一任务。不承诺断网/崩溃恰发生在保存与派发之间时已经开始后台工作，界面区分已保存与后台排队。

持久步骤为start、各source、finish。每个来源用D1 claim_token+30秒lease+最多2次领取，10秒网络等待；有其他有效claim时步骤重试等待35秒。每步运行时/数据库故障最多重试2次；完成/失败来源检查点不重读。外部公开GET与D1不能组成事务，崩溃后可能再读一次网页；不存在“外部调用严格一次”保证。来源HTTP失败直接保留失败结果，自动执行不会开启新的任务或模型调用。任务步骤只有编号/完成信息作为Workflow结果，摘录只存D1；Workflow默认平台保留期与D1记录生命周期分别管理。

每次读取前后检查Goal仍为同版本draft；版本变化阻止旧摘录写入，任务失败、历史不清空。available结果保存新的访问时间和摘录，原始research_evidence不原地覆盖。completed表示各来源已处理，不保证全部读取成功，更不表示研究结论成立；页面显示失败数量与内容未核实。长时研究/LLM阶段需另行设计预算和heartbeat，不沿用短读取lease充当无限运行保证。

GET返回本人最近20个任务与逐项状态，确认Workflow errored/terminated时记录固定安全失败，不把平台错误原文返回。页面仅在已启动queued/running、页面聚焦时每3秒读取；离页取消请求/计时器，不取消服务器实例。未启动任务可明确恢复；已失败任务可重新选来源创建新任务，已结束实例不自动restart。取消/终止按钮、自动派发修复队列尚未实现。

配置main=src/worker.ts，独立导出ResearchWorkflow；Node API单测继续导入index.ts。云、本地dev/test使用不同Workflow名称，固定云部署guard检查绑定/类/入口。参考[官方持久步骤](https://developers.cloudflare.com/workflows/get-started/guide/)、[免费/付费限制](https://developers.cloudflare.com/workflows/reference/limits/)与[计费](https://developers.cloudflare.com/workflows/reference/pricing/)。不通过开发流程购买或升级套餐；运行受现有账号额度约束。
