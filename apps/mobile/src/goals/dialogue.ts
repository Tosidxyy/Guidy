import type { AccountGoal } from './api';
import type { SlotInput } from './clarification';
export type SlotSuggestion = { key: SlotInput['key']; text: string; evidence: string };
export type DialogueReply = { schema_version: 1; kind: 'question'|'referral'|'notice'; question: string; reason: string; source: 'deepseek'|'policy'|'harness'; suggestions?: SlotSuggestion[];requested_slot?: SlotInput['key']|null;stage?:'clarifying'|'research_ready'|'needs_information'|'draft_requested';time_proposal?:'weekly_60_v1' };
export type DialogueRun = { id:string;turn_index:number;user_text:string;status:'running'|'succeeded'|'failed';reply:DialogueReply|null;error_code:string|null;goal_revision?:number };
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
      if(r.stage!==undefined&&(!['clarifying','research_ready','needs_information','draft_requested'].includes(r.stage)||(r.source!=='deepseek'&&r.source!=='harness')||r.requested_slot===undefined))throw new Error('对话阶段格式不正确。');
      if(r.source==='policy'&&(r.requested_slot!==undefined||r.stage!==undefined))throw new Error('安全提示不能采集条件。');
      if(r.source==='harness'&&(r.stage!=='draft_requested'||r.requested_slot!==null||r.suggestions!==undefined))throw new Error('停止状态不正确。');
      if(r.source!=='harness'&&r.stage==='draft_requested')throw new Error('停止状态来源不正确。');
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
