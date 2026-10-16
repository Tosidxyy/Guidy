import type { SearchSource } from './search';
export type PlanSegment={title:string;instructions:string;duration_minutes:number};
export type PlanTask={segments?:PlanSegment[];id:string;key:string;stage:number;title:string;instructions:string;duration_minutes:number;frequency_per_week:number;mandatory:boolean;depends_on:string[];evidence_ids:string[]};
export type TimePreferences={timezone:'UTC'|'Asia/Shanghai';start_minute:number;end_minute:number;excluded_weekdays:number[]};
export type PlanDraft={time_preferences?:TimePreferences;stage_weeks?:{stage:number;weeks:number}[];schema_version:1;status:'draft';verification_status:'unverified';title:string;summary:string;assumptions:string[];risks:string[];tasks:PlanTask[];weekly_minutes:number;time_fit:'needs_user_review';cost_status:'unknown';scheduling_status:'not_checked'};
export type PlanSource=SearchSource&{search_id:string;searched_at:number;provider_request_id:string};
export type PlanContext={schema_version:1;generation_mode?:'chat_auto_v1';goal:{description:string;timeframe_note:string};conditions:{key:string;source:'user';confirmed_at:number|null;value:{schema_version:1;state:'confirmed'|'unknown';text:string}}[];sources:PlanSource[]};
export type PlanAttempt={id:string;goal_revision:number;status:'submitted'|'succeeded'|'failed'|'unknown';error_code:string|null;draft:PlanDraft|null;context:PlanContext;billing_status:'reserved_unknown';created_at:number};
export type PlanSnapshot={daily_limit?:3|4;goal:{id:string;revision:number;status:string};attempts:PlanAttempt[]};
const uuid=(s:unknown)=>typeof s==='string'&&/^[0-9a-f-]{36}$/.test(s);
const text=(s:unknown,max:number)=>typeof s==='string'&&!!s.trim()&&s.length<=max;
export function checkedPlans(v:PlanSnapshot,goalId:string):PlanSnapshot{
 const fail=()=>{throw new Error('草稿数据未通过校验，请读取最新状态。');};
 if(v?.daily_limit!==undefined&&![3,4].includes(v.daily_limit))fail();
 if(!v?.goal||!uuid(goalId)||v.goal.id!==goalId||!Number.isSafeInteger(v.goal.revision)||v.goal.revision<0||typeof v.goal.status!=='string'||!Array.isArray(v.attempts)||v.attempts.length>10)fail();
 if(new Set(v.attempts.map(a=>a?.id)).size!==v.attempts.length)fail();
 for(const a of v.attempts){
  if(!a||!uuid(a.id)||!Number.isSafeInteger(a.goal_revision)||a.goal_revision<0||!['submitted','succeeded','failed','unknown'].includes(a.status)||a.billing_status!=='reserved_unknown'||!Number.isSafeInteger(a.created_at)||a.created_at<=0||(a.error_code!==null&&typeof a.error_code!=='string'))fail();
  const c=a.context;if(!c||c.schema_version!==1||!c.goal||typeof c.goal.description!=='string'||c.goal.description.length>1500||typeof c.goal.timeframe_note!=='string'||c.goal.timeframe_note.length>300||!Array.isArray(c.conditions)||c.conditions.length>3||!Array.isArray(c.sources)||(c.sources.length<1&&c.generation_mode!=='chat_auto_v1')||c.sources.length>3)fail();
  for(const condition of c.conditions){if(!condition||!['outcome','available_time','constraints'].includes(condition.key)||condition.source!=='user'||!condition.value||condition.value.schema_version!==1||typeof condition.value.text!=='string'||condition.value.text.length>300||(condition.value.state==='confirmed'?(!condition.value.text.trim()||!Number.isSafeInteger(condition.confirmed_at)||Number(condition.confirmed_at)<0):condition.value.state!=='unknown'||condition.value.text!==''||condition.confirmed_at!==null))fail();}
  if(c.generation_mode!==undefined&&c.generation_mode!=='chat_auto_v1')fail();
  if(new Set(c.conditions.map(s=>s.key)).size!==c.conditions.length||(c.generation_mode!=='chat_auto_v1'&&!['outcome','available_time'].every(key=>c.conditions.some(s=>s.key===key&&s.value.state==='confirmed'))))fail();
  for(const s of c.sources){if(!s||!uuid(s.source_id)||!uuid(s.search_id)||!text(s.title,160)||!text(s.content,900)||!['provider_content','provider_summary'].includes(s.content_kind)||s.verification_status!=='unverified'||typeof s.snippet!=='string'||s.snippet.length>300||!Number.isSafeInteger(s.searched_at)||s.searched_at<=0||typeof s.provider_request_id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(s.provider_request_id)||typeof s.url!=='string'||s.url.length>2000||/[\p{Cc}\p{Cf}\s\\]/u.test(s.url))fail();const u=new URL(s.url);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.port||!u.hostname.includes('.')||/^[\d.]+$/.test(u.hostname)||u.hostname.startsWith('[')||u.hostname.endsWith('.localhost')||u.hostname.endsWith('.local'))fail();}
  const sourceIds=c.sources.map(s=>s.source_id);if(new Set(sourceIds).size!==sourceIds.length)fail();
  if(a.status!=='succeeded'){if(a.draft!==null)fail();continue;}
  const d=a.draft;if(!d||a.error_code!==null||d.schema_version!==1||d.status!=='draft'||d.verification_status!=='unverified'||d.time_fit!=='needs_user_review'||d.cost_status!=='unknown'||d.scheduling_status!=='not_checked'||!text(d.title,80)||!text(d.summary,300)||!Array.isArray(d.tasks)||d.tasks.length<1||d.tasks.length>6||![d.assumptions,d.risks].every(list=>Array.isArray(list)&&list.length<=5&&list.every(s=>text(s,160))))fail();if(!d)continue;
  const pref=d.time_preferences;if(pref!==undefined&&(!pref||!['UTC','Asia/Shanghai'].includes(pref.timezone)||!Number.isInteger(pref.start_minute)||!Number.isInteger(pref.end_minute)||pref.start_minute<0||pref.end_minute>1440||pref.end_minute-pref.start_minute<5||!Array.isArray(pref.excluded_weekdays)||pref.excluded_weekdays.length>7||new Set(pref.excluded_weekdays).size!==pref.excluded_weekdays.length||pref.excluded_weekdays.some(n=>!Number.isInteger(n)||n<0||n>6)))fail();
  if(d.stage_weeks!==undefined){const stages=[...new Set(d.tasks.map(t=>t.stage))].sort((a,b)=>a-b);if(!Array.isArray(d.stage_weeks)||d.stage_weeks.length!==stages.length||d.stage_weeks.some((s,i)=>!s||s.stage!==stages[i]||!Number.isInteger(s.weeks)||s.weeks<1||s.weeks>12)||d.stage_weeks.reduce((n,s)=>n+s.weeks,0)>12)fail();}
  for(const t of d.tasks)if(t.segments!==undefined&&(!Array.isArray(t.segments)||t.segments.length<1||t.segments.length>3||t.segments.some(s=>!s||!text(s.title,40)||!text(s.instructions,120)||!Number.isInteger(s.duration_minutes)||s.duration_minutes<1)||t.segments.reduce((n,s)=>n+s.duration_minutes,0)!==t.duration_minutes))fail();
  const ids=d.tasks.map(t=>t?.id);if(new Set(ids).size!==ids.length||new Set(d.tasks.map(t=>t?.key)).size!==ids.length)fail();
  for(const t of d.tasks){if(!t||!uuid(t.id)||!/^t[1-6]$/.test(t.key)||!text(t.title,80)||!text(t.instructions,400)||!Number.isInteger(t.stage)||t.stage<1||t.stage>3||!Number.isInteger(t.duration_minutes)||t.duration_minutes<5||t.duration_minutes>120||!Number.isInteger(t.frequency_per_week)||t.frequency_per_week<1||t.frequency_per_week>7||typeof t.mandatory!=='boolean'||!Array.isArray(t.depends_on)||t.depends_on.length>5||new Set(t.depends_on).size!==t.depends_on.length||t.depends_on.some(id=>id===t.id||!ids.includes(id))||!Array.isArray(t.evidence_ids)||t.evidence_ids.length>3||new Set(t.evidence_ids).size!==t.evidence_ids.length||t.evidence_ids.some(id=>!sourceIds.includes(id)))fail();}
  const visiting=new Set<string>(),done=new Set<string>();const visit=(id:string)=>{if(visiting.has(id))fail();if(done.has(id))return;visiting.add(id);const t=d.tasks.find(t=>t.id===id)!;for(const dep of t.depends_on){if(d.tasks.find(t=>t.id===dep)!.stage>t.stage)fail();visit(dep);}visiting.delete(id);done.add(id);};d.tasks.forEach(t=>visit(t.id));
  if((!d.tasks.some(t=>t.evidence_ids.length)&&!(c.generation_mode==='chat_auto_v1'&&c.sources.length===0))||d.weekly_minutes!==d.tasks.reduce((sum,t)=>sum+t.duration_minutes*t.frequency_per_week,0))fail();
 }
 return v;
}
export function planError(code:string):string{
 const map:Record<string,string>={PLAN_SCHEMA_JSON:'AI未返回有效的草稿数据，未保存草稿。',PLAN_SCHEMA_OBJECT:'AI草稿整体格式不符合要求，未保存草稿。',PLAN_SCHEMA_FIELDS:'AI草稿包含不支持的字段，未保存草稿。',PLAN_SCHEMA_TITLE:'AI草稿标题不符合格式要求，未保存草稿。',PLAN_SCHEMA_SUMMARY:'AI草稿摘要不符合格式要求，未保存草稿。',PLAN_SCHEMA_ASSUMPTIONS:'AI草稿假设列表不符合要求，未保存草稿。',PLAN_SCHEMA_RISKS:'AI草稿风险列表不符合要求，未保存草稿。',PLAN_SCHEMA_TASKS:'AI草稿任务列表或数量不符合要求，未保存草稿。',PLAN_SCHEMA_KEYS:'AI草稿任务编号重复，未保存草稿。',RESEARCH_NOT_READY:'请先确认目标成果与可用时间；有安全提示的目标需先核对。',PLAN_INVALID_SOURCES:'请选择当前目标版本中已成功搜索的资料。',PLAN_INSUFFICIENT_EVIDENCE:'这些资料只有搜索片段，没有足够正文或相关摘要，请补充搜索资料。',PLAN_INVALID_DRAFT:'旧草稿未通过校验，当时未记录细分原因。原请求不会重新生成。',PLAN_INVALID_SCHEMA:'AI草稿的字段或整体格式不符合要求，未保存草稿。',PLAN_INVALID_TASK:'AI任务的时长、频率或字段不符合要求，未保存草稿。',PLAN_INVALID_CITATION:'AI引用了未提供的资料或没有有效引用，未保存草稿。',PLAN_INVALID_DEPENDENCY:'AI任务依赖存在无效引用、循环或阶段冲突，未保存草稿。',PLAN_UNSAFE_CONTENT:'AI草稿包含不允许的效果承诺、执行表述、网址或剂量建议，未保存草稿。',PLAN_LIMIT_OR_BUSY:'已有草稿请求尚未结束或达到生成上限，请先读取状态。',PLAN_RESULT_UNKNOWN:'尚不能确定生成是否完成或计费。请读取状态，不会自动重新生成。',AI_NOT_CONFIGURED:'AI服务尚未配置。',AI_CREDENTIAL_INVALID:'AI服务凭据无效，请检查服务端配置。',AI_BALANCE_REQUIRED:'AI服务余额不足。',AI_RATE_LIMITED:'AI服务暂时限流，本次尝试已记录。',CONTEXT_CHANGED:'目标或安全状态已改变，旧草稿未保存；请读取最新状态。',IDEMPOTENCY_CONFLICT:'请求内容已改变，请先读取状态。'};
 return map[code]??'草稿未完成，请先读取状态；不会自动重新调用模型。';
}

export type ReviewChange={task_id:string;duration_minutes:number;frequency_per_week:number};
export type ReviewSnapshot={goal:PlanSnapshot['goal'];can_edit:boolean;source:PlanAttempt;current_revision:number;receipt_revision?:number;reviews:{id:string;revision:number;draft:PlanDraft;source:'user';created_at:number;weekly_capacity_minutes?:number|null}[]};
export function checkedReviews(v:ReviewSnapshot,goalId:string,attemptId:string):ReviewSnapshot{
 const fail=()=>{throw new Error('审阅版本未通过校验，请读取最新状态。');};
 if(!v||typeof v.can_edit!=='boolean'||v.source?.id!==attemptId||v.source.status!=='succeeded'||!Number.isInteger(v.current_revision)||v.current_revision<0||v.current_revision>20||!Array.isArray(v.reviews)||v.reviews.length>20)fail();
 checkedPlans({goal:v.goal,attempts:[v.source]},goalId);
 const canonical=(d:PlanDraft)=>JSON.stringify({...d,weekly_minutes:0,tasks:d.tasks.map(t=>({...t,duration_minutes:0,frequency_per_week:0}))});
 const original=canonical(v.source.draft!);let previous=21;
 for(const r of v.reviews){if(!r||!uuid(r.id)||r.source!=='user'||!Number.isInteger(r.revision)||r.revision<1||r.revision>=previous||!Number.isSafeInteger(r.created_at)||r.created_at<=0)fail();previous=r.revision;if(r.weekly_capacity_minutes!==undefined&&r.weekly_capacity_minutes!==null&&(!Number.isInteger(r.weekly_capacity_minutes)||r.weekly_capacity_minutes<0||r.weekly_capacity_minutes>10080))fail();checkedPlans({goal:v.goal,attempts:[{...v.source,id:r.id,draft:r.draft}]},goalId);if(canonical(r.draft)!==original)fail();}
 if(v.current_revision!==(v.reviews[0]?.revision??0)||v.reviews.length!==v.current_revision||(v.receipt_revision!==undefined&&!v.reviews.some(r=>r.revision===v.receipt_revision)))fail();
 if(v.can_edit&&(v.goal.status!=='draft'||v.goal.revision!==v.source.goal_revision))fail();
 return v;
}
export function reviewNumber(value:string,min:number,max:number):number|null{
 const s=value.replace(/[０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xfee0)).trim();if(!/^\d{1,5}$/.test(s))return null;const n=Number(s);return n>=min&&n<=max?n:null;
}
export function reviewError(code:string):string{
 const map:Record<string,string>={REVIEW_SOURCE_CHANGED:'已有新的方案草稿，请基于最新草稿重新描述调整；旧建议不会套用。',REVIEW_LIMIT_REACHED:'这份草稿已达到20个审阅版本上限，已有版本仍可查看。',REVIEW_INVALID_CHANGES:'请检查任务：每次5–120整数分钟，每周1–7次，每周可用时间为0–10080整数分钟或留空；不修改任务编号或其他字段。',REVIEW_NO_CHANGES:'任务时长、频次与可用时间没有变化，无需保存新版本。',REVIEW_VERSION_CHANGED:'已有新的审阅版本，请读取并核对。你的输入仍保留。',REVIEW_CONTEXT_CHANGED:'目标条件或安全状态已改变，这份旧草稿目前不可调整。输入仍保留。',REVIEW_IDEMPOTENCY_CONFLICT:'保存请求内容不一致，请读取审阅版本后核对。',REVIEW_INVALID_SOURCE:'草稿来源地址不正确。'};return map[code]??'审阅版本未保存，请读取状态；输入仍保留。';
}

export function effortSummary(total:number|null,capacity:number|null):string{
 if(total===null)return '请填写有效的任务时长与次数。';
 if(capacity===null)return '尚未填写每周可用时间，无法比较投入。';
 const delta=capacity-total;return delta<0?`全部任务每周合计 ${total} 分钟，比可用时间超出 ${-delta} 分钟。`:delta===0?`全部任务每周合计 ${total} 分钟，刚好用满可用时间。`:`全部任务每周合计 ${total} 分钟，剩余 ${delta} 分钟。`;
}
