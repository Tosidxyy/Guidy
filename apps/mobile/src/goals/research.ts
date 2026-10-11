export type Evidence = {id:string;goal_revision:number;source_url:string;claim:string;caveat:string;status:'fetching'|'available'|'failed';verification_status:'unverified';title:string;excerpt:string;error_code:string|null;retrieved_at:number|null;created_at:number};
export function checkedEvidence(value:unknown):Evidence[]{
  if(!Array.isArray(value)||value.length>20)throw new Error('来源响应格式不正确。');
  for(const e of value){
    if(!e||typeof e.id!=='string'||!Number.isSafeInteger(e.goal_revision)||e.goal_revision<0||typeof e.source_url!=='string'||!['fetching','available','failed'].includes(e.status)||e.verification_status!=='unverified'||typeof e.claim!=='string'||e.claim.length>300||typeof e.caveat!=='string'||e.caveat.length>300||typeof e.title!=='string'||e.title.length>160||typeof e.excerpt!=='string'||e.excerpt.length>1200||(e.status==='available'&&(!e.excerpt||!Number.isSafeInteger(e.retrieved_at))))throw new Error('来源状态未通过校验。');
    const url=new URL(e.source_url);if(url.protocol!=='https:'||!['learnenglish.britishcouncil.org','www.nhs.uk','www.who.int','www.aad.org'].includes(url.hostname)||url.username||url.password||url.port||url.search)throw new Error('来源链接未通过校验。');
  }
  return value;
}
export function sourceError(code:string):string{
  if(code==='CONTEXT_CHANGED'||code==='IDEMPOTENCY_CONFLICT')return '目标或请求内容已改变，请重新读取资料状态并核对。你的输入仍保留。';
  if(code==='SOURCE_ACCESS_DENIED')return '来源网站拒绝服务器读取。请打开原网页查看，或选择其他可访问来源；反复重试可能仍被拒绝。';
  if(code==='SOURCE_NOT_FOUND')return '来源网页不存在，请核对链接。';
  if(code==='SOURCE_RATE_LIMITED')return '来源网站暂时限流，请稍后再试。';
  if(code==='SOURCE_SERVER_ERROR'||/^SOURCE_SERVER_ERROR_5\d{2}$/.test(code))return '来源网站或网络网关当前异常，服务器无法读取。你可打开原网页查看，或稍后重试。';
  if(code==='SOURCE_NETWORK_ERROR')return '服务器无法连接来源网站，请稍后重试或选择其他来源。';
  if(code==='SOURCE_UNAVAILABLE')return '上次未能读取网页，具体原因未记录。你可打开原网页查看，或选择其他来源。';
  if(code==='SOURCE_URL_REJECTED')return '暂仅支持 British Council、NHS、WHO、AAD 的指定官网 HTTPS 网页，不含查询参数。';
  if(code==='SOURCE_REDIRECT_REJECTED')return '来源发生跳转，请打开官网后复制最终网页链接。';
  if(code==='SOURCE_TOO_LARGE')return '网页超过读取上限，请选择较短的资料页。';
  if(code==='SOURCE_TYPE_REJECTED')return '暂只读取 HTML 网页，不支持 PDF 或文件。';
  if(code==='SOURCE_TIMEOUT')return '读取超时，未核实资料；可以保留链接后明确重试。';
  if(code==='SOURCE_LIMIT_OR_BUSY')return '有资料正在读取或已达到测试上限，请先读取状态。';
  return '来源未读取成功，未核实资料。请检查链接或读取最新状态。';
}
export type ResearchJob = {id:string;goal_revision:number;status:'queued'|'running'|'completed'|'failed';dispatched:0|1;error_code:string|null;items:{position:number;source_url:string;claim:string;caveat:string;status:'pending'|'reading'|'available'|'failed';title:string;excerpt:string;retrieved_at:number|null;error_code:string|null}[]};
export function checkedJobs(jobs:ResearchJob[]):ResearchJob[]{
  if(!Array.isArray(jobs)||jobs.length>20)throw new Error('任务响应格式不正确。');
  for(const job of jobs){
    if(!job||typeof job.id!=='string'||!Number.isSafeInteger(job.goal_revision)||job.goal_revision<0||!['queued','running','completed','failed'].includes(job.status)||![0,1].includes(job.dispatched)||!Array.isArray(job.items)||job.items.length<1||job.items.length>3||new Set(job.items.map(i=>i.position)).size!==job.items.length)throw new Error('任务状态未通过校验。');
    for(const item of job.items){
      if(!Number.isInteger(item.position)||item.position<0||item.position>2||!['pending','reading','available','failed'].includes(item.status))throw new Error('任务来源未通过校验。');
      checkedEvidence([{...item,id:`${job.id}:${item.position}`,goal_revision:job.goal_revision,status:item.status==='pending'||item.status==='reading'?'fetching':item.status,verification_status:'unverified'}]);
    }
    if(job.status==='completed'&&job.items.some(i=>['pending','reading'].includes(i.status)))throw new Error('任务尚未处理完成。');
  }
  return jobs;
}
export function jobError(code:string):string{
  if(code==='WORKFLOW_NOT_CONFIGURED')return '后台任务服务尚未配置。';
  if(code==='WORKFLOW_START_FAILED')return '任务已保存，后台启动失败。请读取状态后尝试启动已保存任务。';
  if(code==='JOB_LIMIT_OR_BUSY')return '有任务尚未结束或已达到测试上限。';
  if(code==='INVALID_SOURCES')return '请选择当前目标版本中已结束读取的来源，最多3项。';
  if(code==='CONTEXT_CHANGED')return '目标已改变，本次旧资料任务停止。';
  return '后台资料任务未完成，请查看状态；不会自动创建新任务。';
}
