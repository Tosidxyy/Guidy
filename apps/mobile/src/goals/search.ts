export type SearchSource = {source_id:string;title:string;url:string;snippet:string;content:string;content_kind:'provider_content'|'provider_summary'|'snippet_only';published_at:string|null;verification_status:'unverified'};
export type SearchAttempt = {id:string;goal_revision:number;query:string;provider:'doubao-custom';status:'submitted'|'succeeded'|'failed'|'unknown';billing_status:'reserved_unknown';error_code:string|null;created_at:number;result:null|{provider:'doubao-custom';provider_request_id:string;searched_at:number;sources:SearchSource[]}};
export type SearchSnapshot = {goal:{id:string;revision:number;status:string};attempts:SearchAttempt[]};
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f-]{36}$/.test(v);
const timestamp=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
export function safeSearchLink(raw:string):boolean{
  try{const u=new URL(raw);return raw.length<=2000&&['https:','http:'].includes(u.protocol)&&!u.username&&!u.password&&!u.port&&u.hostname.includes('.')&&!/^[\d.]+$/.test(u.hostname)&&!u.hostname.startsWith('[')&&!u.hostname.endsWith('.local')&&!u.hostname.endsWith('.localhost')&&!/[\p{Cc}\p{Cf}\s\\]/u.test(raw);}catch{return false;}
}
export function validSearchQuery(query:string):boolean{return !!query.trim()&&[...query.trim()].length<=100&&!/[\p{Cc}\p{Cf}]|@|https?:|\d{7,}/u.test(query);}
export function checkedSearchSnapshot(value:SearchSnapshot,goalId:string):SearchSnapshot{
  const fail=()=>{throw new Error('搜索结果格式未通过校验，请重新读取状态。');};
  if(!value?.goal||value.goal.id!==goalId||!uuid(goalId)||!Number.isSafeInteger(value.goal.revision)||value.goal.revision<0||typeof value.goal.status!=='string'||!Array.isArray(value.attempts)||value.attempts.length>20)fail();
  if(new Set(value.attempts.map(a=>a?.id)).size!==value.attempts.length)fail();
  for(const a of value.attempts){
    if(!a||!uuid(a.id)||!Number.isSafeInteger(a.goal_revision)||a.goal_revision<0||typeof a.query!=='string'||!validSearchQuery(a.query)||a.provider!=='doubao-custom'||!['submitted','succeeded','failed','unknown'].includes(a.status)||a.billing_status!=='reserved_unknown'||!timestamp(a.created_at)||(a.error_code!==null&&typeof a.error_code!=='string'))fail();
    if(a.status!=='succeeded'){if(a.result!==null)fail();continue;}
    const r=a.result;
    if(!r||a.error_code!==null||r.provider!=='doubao-custom'||typeof r.provider_request_id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(r.provider_request_id)||!timestamp(r.searched_at)||!Array.isArray(r.sources)||r.sources.length>5)fail();
    if(!r)continue;
    if(new Set(r.sources.map(s=>s?.source_id)).size!==r.sources.length)fail();
    for(const s of r.sources){
      if(!s||!uuid(s.source_id)||typeof s.title!=='string'||!s.title||s.title.length>160||typeof s.url!=='string'||!safeSearchLink(s.url)||typeof s.snippet!=='string'||s.snippet.length>300||typeof s.content!=='string'||s.content.length>1200||!['provider_content','provider_summary','snippet_only'].includes(s.content_kind)||s.verification_status!=='unverified'||(s.content_kind==='snippet_only'?!!s.content:!s.content)||(s.published_at!==null&&(typeof s.published_at!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(s.published_at)||!Number.isFinite(Date.parse(s.published_at)))))fail();
    }
  }
  return value;
}
export function searchError(code:string):string{
  const messages:Record<string,string>={SEARCH_NOT_CONFIGURED:'搜索服务尚未配置，请稍后再试。',SEARCH_QUERY_REJECTED:'请填写100字以内的通用搜索问题，不含邮箱、电话或网址。',RESEARCH_NOT_READY:'请先确认目标成果与可用时间；有安全提示的目标需先核对。',CONTEXT_CHANGED:'目标已改变，请读取最新状态后核对。',IDEMPOTENCY_CONFLICT:'本次请求内容不一致，请读取状态。',SEARCH_LIMIT_OR_BUSY:'已有搜索尚未结束或达到调用上限，请先读取状态。',SEARCH_ACCESS_DENIED:'搜索服务拒绝请求，请检查服务端配置。',SEARCH_QUOTA_EXHAUSTED:'搜索服务额度不足，请检查服务额度。',SEARCH_RATE_LIMITED:'搜索服务暂时限流。本次已记录，请勿反复提交。',SEARCH_RESULT_UNKNOWN:'尚不能确定搜索是否完成或计费。请读取状态，不会自动重新搜索。'};
  return messages[code]??'搜索未完成，输入仍保留。请先读取状态，不会自动重新搜索。';
}
