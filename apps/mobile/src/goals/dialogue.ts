import {checkedSchedule,type ScheduleData} from './schedule.ts';
import type { AccountGoal } from './api';
import type { SlotInput } from './clarification';
export type EditProposal={attempt_id:string;goal_revision:number;review_revision:number;task_id:string;task_title:string;before:{duration_minutes:number;frequency_per_week:number};after:{duration_minutes:number;frequency_per_week:number};weekly_before:number;weekly_after:number};
export function isDraftEditText(text:string){return /(?:改|调整|缩短|增加|减少).*(?:分钟|每次|每周|频次|时长)|第\s*[一二三四五六1-6].*(?:项|任务|步骤)/u.test(text.replace(/[０-９]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xfee0)));}
export type SlotSuggestion = { key: SlotInput['key']; text: string; evidence: string };
export type DialogueReply = { schema_version: 1; kind: 'question'|'referral'|'notice'; question: string; reason: string; source: 'deepseek'|'policy'|'harness'; suggestions?: SlotSuggestion[];requested_slot?: SlotInput['key']|null;stage?:'clarifying'|'research_ready'|'needs_information'|'draft_requested'|'edit_proposed'|'edit_guidance'|'schedule_guidance'|'schedule_proposed'|'schedule_preview';schedule?:ScheduleData;edit_proposal?:EditProposal;time_proposal?:'weekly_60_v1' };
export type DialogueRun = { id:string;turn_index:number;user_text:string;status:'running'|'succeeded'|'failed';reply:DialogueReply|null;error_code:string|null;goal_revision?:number;edit_receipt_revision?:number|null;edit_proposal_stale?:boolean;schedule_stale?:boolean };
export type Dialogue = { clarification_budget?:{daily_limit:8|24;used:number;remaining:number;reset_at:number;global_limited:boolean;allowed:boolean};asked_topics?: SlotInput['key'][];goal:AccountGoal;chat_revision:number;runs:DialogueRun[] };
export function checkedDialogue(value: Dialogue): Dialogue {
  if(!value||!Number.isSafeInteger(value.chat_revision)||value.chat_revision<0||!Array.isArray(value.runs)||value.runs.length>30)throw new Error('对话响应格式不正确。');
  if(value.asked_topics!==undefined&&(!Array.isArray(value.asked_topics)||value.asked_topics.length>3||new Set(value.asked_topics).size!==value.asked_topics.length||value.asked_topics.some(k=>!['outcome','available_time','constraints'].includes(k))))throw new Error('澄清进度格式不正确。');
  const budget=value.clarification_budget;if(value.clarification_budget!==undefined&&!budget)throw new Error('澄清额度格式不正确。');if(budget&&(![8,24].includes(budget.daily_limit)||!Number.isSafeInteger(budget.used)||budget.used<0||!Number.isSafeInteger(budget.remaining)||budget.remaining!==Math.max(0,budget.daily_limit-budget.used)||!Number.isSafeInteger(budget.reset_at)||budget.reset_at<=0||typeof budget.global_limited!=='boolean'||budget.allowed!==(budget.remaining>0&&!budget.global_limited)))throw new Error('澄清额度格式不正确。');
  for(const run of value.runs){
    if(!run||typeof run.id!=='string'||!Number.isSafeInteger(run.turn_index)||run.turn_index<1||typeof run.user_text!=='string'||run.user_text.length>600||!['running','succeeded','failed'].includes(run.status))throw new Error('对话响应格式不正确。');
    if(run.status==='succeeded'){
      const r=run.reply;
      if(!r||r.schema_version!==1||!['question','referral','notice'].includes(r.kind)||!['deepseek','policy','harness'].includes(r.source)||typeof r.question!=='string'||!r.question.trim()||r.question.length>240||typeof r.reason!=='string'||r.reason.length>160||(r.kind==='question'?r.source!=='deepseek':r.kind==='referral'?r.source!=='policy':r.source!=='harness'))throw new Error('AI 回复未通过校验。');
      if(r.requested_slot!==undefined&&r.requested_slot!==null&&!['outcome','available_time','constraints'].includes(r.requested_slot))throw new Error('对话问题格式不正确。');
      if(r.stage!==undefined&&(!['clarifying','research_ready','needs_information','draft_requested','edit_proposed','edit_guidance','schedule_guidance','schedule_proposed','schedule_preview'].includes(r.stage)||(r.source!=='deepseek'&&r.source!=='harness')||r.requested_slot===undefined))throw new Error('对话阶段格式不正确。');
      if(r.source==='policy'&&(r.requested_slot!==undefined||r.stage!==undefined))throw new Error('安全提示不能采集条件。');
      if(r.source==='harness'&&(!['draft_requested','edit_proposed','edit_guidance','schedule_guidance','schedule_proposed','schedule_preview'].includes(r.stage??'')||r.requested_slot!==null||r.suggestions!==undefined))throw new Error('停止状态不正确。');
      if(r.source!=='harness'&&['draft_requested','edit_proposed','edit_guidance','schedule_guidance','schedule_proposed','schedule_preview'].includes(r.stage??''))throw new Error('停止状态来源不正确。');
      if(['schedule_proposed','schedule_preview'].includes(r.stage??'')){if(r.source!=='harness')throw new Error('排程来源不正确。');checkedSchedule(r.schedule,r.stage!);}else if(r.schedule!==undefined)throw new Error('排程状态不正确。');
      if(run.schedule_stale!==undefined&&typeof run.schedule_stale!=='boolean')throw new Error('排程版本状态不正确。');
      if(r.stage==='edit_proposed'){const p=r.edit_proposal;if(!p||![p.attempt_id,p.task_id].every(id=>typeof id==='string'&&/^[0-9a-f-]{36}$/.test(id))||typeof p.task_title!=='string'||!p.task_title.trim()||p.task_title.length>80||!Number.isInteger(p.goal_revision)||p.goal_revision<0||!Number.isInteger(p.review_revision)||p.review_revision<0||p.review_revision>=20||![p.before,p.after].every(v=>v&&Number.isInteger(v.duration_minutes)&&v.duration_minutes>=5&&v.duration_minutes<=120&&Number.isInteger(v.frequency_per_week)&&v.frequency_per_week>=1&&v.frequency_per_week<=7)||!Number.isSafeInteger(p.weekly_before)||p.weekly_before<5||p.weekly_before>5040||!Number.isSafeInteger(p.weekly_after)||p.weekly_after<5||p.weekly_after>5040||p.weekly_after!==p.weekly_before-p.before.duration_minutes*p.before.frequency_per_week+p.after.duration_minutes*p.after.frequency_per_week)throw new Error('草稿调整差异不正确。');}else if(r.edit_proposal!==undefined)throw new Error('草稿调整状态不正确。');
      if(run.edit_proposal_stale!==undefined&&(typeof run.edit_proposal_stale!=='boolean'||(run.edit_proposal_stale&&r.stage!=='edit_proposed')))throw new Error('调整版本状态不正确。');
      if(run.edit_receipt_revision!==undefined&&run.edit_receipt_revision!==null&&(r.stage!=='edit_proposed'||!Number.isInteger(run.edit_receipt_revision)||run.edit_receipt_revision<1||run.edit_receipt_revision>20))throw new Error('调整回执不正确。');
      if(r.time_proposal!==undefined&&(r.time_proposal!=='weekly_60_v1'||r.source!=='deepseek'||r.requested_slot!=='available_time'))throw new Error('时间建议格式不正确。');
      if(r.suggestions!==undefined){
        if(r.source!=='deepseek'||!Array.isArray(r.suggestions)||r.suggestions.length>3)throw new Error('条件建议格式不正确。');
        const seen=new Set<string>();
        for(const s of r.suggestions){
          if(!s||!['outcome','available_time','constraints'].includes(s.key)||seen.has(s.key)||typeof s.text!=='string'||!s.text.trim()||s.text!==s.text.trim()||s.text.length>300||s.evidence!==s.text||!run.user_text.includes(s.evidence))throw new Error('条件建议缺少有效原文依据。');
          seen.add(s.key);
        }
      }
    }else if(run.reply!==null)throw new Error('对话状态不正确。');
  }
  return value;
}
export function reviewSuggestions(dialogue:Dialogue,runId:string,goalRevision:number):SlotSuggestion[]{
  const run=dialogue.runs.find(r=>r.id===runId);
  if(dialogue.goal.status!=='draft'||dialogue.goal.revision!==goalRevision||run?.goal_revision!==goalRevision||run.status!=='succeeded'||run.reply?.source!=='deepseek')throw new Error('这条建议对应的目标已改变，请返回对话重新澄清。');
  return run.reply.suggestions??[];
}
export function dialogueError(code:string):string {
  if(code==='CLARIFICATION_MINIMUM_NOT_MET')return '需要先询问三个核心信息，再停止提问；可以回答暂不确定。';
  if(code==='AI_NOT_CONFIGURED')return 'AI 服务尚未配置，请先完成服务端设置。';
  if(code==='AI_CREDENTIAL_INVALID')return 'AI 服务密钥未通过验证，请更新服务端配置。';
  if(code==='AI_BALANCE_REQUIRED')return 'AI 服务余额不足，请补充测试账户额度。';
  if(code==='AI_DAILY_LIMIT')return '当天累计澄清次数已用完；三项核心信息已问过时，可以停止提问并准备草稿。已有回答和输入仍保留。';
  if(code==='AI_GLOBAL_LIMIT')return '当前测试服务的澄清总量已达上限；三项核心信息已问过时，可以停止提问并准备草稿。';
  if(code==='AI_RATE_LIMITED')return 'AI 服务请求较多，请稍后再试。';
  if(code==='AI_INVALID_RESPONSE'||code==='AI_REPEATED_QUESTION')return 'AI 建议未通过校验，未保存回复。可查看状态后重试。';
  if(['CONTEXT_CHANGED','CONVERSATION_CHANGED','IDEMPOTENCY_CONFLICT'].includes(code))return '目标或对话已改变，请重新读取。你的输入仍保留。';
  if(code==='AI_TIMEOUT')return 'AI 生成超时，你的消息已保存。请查看状态后重试。';
  if(code==='CONTEXT_TOO_LARGE')return '当前上下文较长，请先精简目标与条件后再试。';
  return 'AI 澄清暂未完成，请查看状态后重试。';
}
