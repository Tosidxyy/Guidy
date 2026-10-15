import {checkedBusy,type BusyProposal} from './calendar.ts';
import {checkedSchedule,type ScheduleData} from './schedule.ts';
import type { AccountGoal } from './api';
import type { SlotInput } from './clarification';
export type EditProposal={attempt_id:string;goal_revision:number;review_revision:number;task_id:string;task_title:string;before:{duration_minutes:number;frequency_per_week:number};after:{duration_minutes:number;frequency_per_week:number};weekly_before:number;weekly_after:number};
export type SlotSuggestion = { key: SlotInput['key']; text: string; evidence: string };
export type DialogueReply = { schema_version: 1; kind: 'question'|'referral'|'notice'; question: string; reason: string; source: 'deepseek'|'policy'|'harness'; suggestions?: SlotSuggestion[];requested_slot?: SlotInput['key']|null;base_attempt_id?:string;stage?:'refine_question'|'clarifying'|'research_ready'|'needs_information'|'replan_question'|'plans_cleared'|'draft_requested'|'edit_proposed'|'edit_guidance'|'schedule_guidance'|'schedule_proposed'|'schedule_preview'|'busy_guidance'|'busy_proposed'|'busy_saved';busy?:BusyProposal;schedule_help?:{example_text:string};schedule?:ScheduleData;schedule_mode?:'first_stage_week_v1';edit_proposal?:EditProposal;time_proposal?:'weekly_60_v1' };
export type DialogueRun = { id:string;turn_index:number;user_text:string;status:'running'|'succeeded'|'failed';reply:DialogueReply|null;error_code:string|null;goal_revision?:number;edit_receipt_revision?:number|null;edit_proposal_stale?:boolean;schedule_stale?:boolean;busy_proposal_stale?:boolean };
export type Dialogue = {auto_schedule_key?:string|null;auto_schedule_run_id?:string|null;auto_schedule?:ScheduleData|null; calendar_revision?:number; clarification_budget?:{daily_limit:8|24;used:number;remaining:number;reset_at:number;global_limited:boolean;allowed:boolean};asked_topics?: SlotInput['key'][];goal:AccountGoal;chat_revision:number;runs:DialogueRun[] };
export function checkedDialogue(value: Dialogue): Dialogue {
  if(value.auto_schedule_key!==undefined&&value.auto_schedule_key!==null&&(typeof value.auto_schedule_key!=='string'||value.auto_schedule_key.length>128||!/^auto_schedule_[0-9a-f-]{36}_\d+_\d+_\d+$/.test(value.auto_schedule_key)))throw new Error('日程准备状态不正确。');
  if(!value||!Number.isSafeInteger(value.chat_revision)||value.chat_revision<0||!Array.isArray(value.runs)||value.runs.length>30)throw new Error('对话响应格式不正确。');
  if(value.asked_topics!==undefined&&(!Array.isArray(value.asked_topics)||value.asked_topics.length>3||new Set(value.asked_topics).size!==value.asked_topics.length||value.asked_topics.some(k=>!['outcome','available_time','constraints'].includes(k))))throw new Error('澄清进度格式不正确。');
  const budget=value.clarification_budget;if(value.clarification_budget!==undefined&&!budget)throw new Error('澄清额度格式不正确。');if(budget&&(![8,24].includes(budget.daily_limit)||!Number.isSafeInteger(budget.used)||budget.used<0||!Number.isSafeInteger(budget.remaining)||budget.remaining!==Math.max(0,budget.daily_limit-budget.used)||!Number.isSafeInteger(budget.reset_at)||budget.reset_at<=0||typeof budget.global_limited!=='boolean'||budget.allowed!==(budget.remaining>0&&!budget.global_limited)))throw new Error('澄清额度格式不正确。');
  if(value.calendar_revision!==undefined&&(!Number.isSafeInteger(value.calendar_revision)||value.calendar_revision<0))throw new Error('日历版本不正确。');
  if(value.auto_schedule_run_id!==undefined&&value.auto_schedule_run_id!==null&&(!/^[0-9a-f-]{36}$/.test(value.auto_schedule_run_id)||!value.auto_schedule))throw new Error('日程回执格式不正确。');
  if(value.auto_schedule)checkedSchedule(value.auto_schedule,'schedule_preview');
  for(const run of value.runs){
    if(!run||typeof run.id!=='string'||!Number.isSafeInteger(run.turn_index)||run.turn_index<1||typeof run.user_text!=='string'||run.user_text.length>600||!['running','succeeded','failed'].includes(run.status))throw new Error('对话响应格式不正确。');
    if(run.status==='succeeded'){
      const r=run.reply;
      if(!r||r.schema_version!==1||!['question','referral','notice'].includes(r.kind)||!['deepseek','policy','harness'].includes(r.source)||typeof r.question!=='string'||!r.question.trim()||r.question.length>240||typeof r.reason!=='string'||r.reason.length>160||(r.kind==='question'?(r.source!=='deepseek'&&!(r.source==='harness'&&['refine_question','replan_question'].includes(r.stage??''))):r.kind==='referral'?r.source!=='policy':r.source!=='harness'))throw new Error('AI 回复未通过校验。');
      if(r.requested_slot!==undefined&&r.requested_slot!==null&&!['outcome','available_time','constraints'].includes(r.requested_slot))throw new Error('对话问题格式不正确。');
      if(r.stage==='refine_question'&&(r.kind!=='question'||r.source!=='harness'||typeof r.base_attempt_id!=='string'||!/^[0-9a-f-]{36}$/.test(r.base_attempt_id)))throw new Error('修改问题对应的草稿不正确。');
      if(r.stage!==undefined&&(!['refine_question','clarifying','research_ready','needs_information','replan_question','plans_cleared','draft_requested','edit_proposed','edit_guidance','schedule_guidance','schedule_proposed','schedule_preview','busy_guidance','busy_proposed','busy_saved'].includes(r.stage)||(r.source!=='deepseek'&&r.source!=='harness')||r.requested_slot===undefined))throw new Error('对话阶段格式不正确。');
      if(r.source==='policy'&&(r.requested_slot!==undefined||r.stage!==undefined))throw new Error('安全提示不能采集条件。');
      if(r.source==='harness'&&(!['refine_question','replan_question','plans_cleared','draft_requested','edit_proposed','edit_guidance','schedule_guidance','schedule_proposed','schedule_preview','busy_guidance','busy_proposed','busy_saved'].includes(r.stage??'')||r.requested_slot!==null||r.suggestions!==undefined))throw new Error('停止状态不正确。');
      if(r.source!=='harness'&&['replan_question','plans_cleared','draft_requested','edit_proposed','edit_guidance','schedule_guidance','schedule_proposed','schedule_preview','busy_guidance','busy_proposed','busy_saved'].includes(r.stage??''))throw new Error('停止状态来源不正确。');
      if(['busy_proposed','busy_saved'].includes(r.stage??'')){if(r.source!=='harness')throw new Error('占用来源不正确。');checkedBusy(r.busy,r.stage!);}else if(r.busy!==undefined)throw new Error('占用状态不正确。');
      if(r.schedule_help!==undefined&&(!r.schedule_help||r.source!=='harness'||r.stage!=='schedule_guidance'||typeof r.schedule_help.example_text!=='string'||r.schedule_help.example_text.length>120||!r.schedule_help.example_text.startsWith('北京时间，')))throw new Error('时间示例格式不正确。');
      if(r.schedule_mode!==undefined&&(r.schedule_mode!=='first_stage_week_v1'||r.source!=='harness'||!['schedule_proposed','schedule_preview','schedule_guidance'].includes(r.stage??'')))throw new Error('重复预览模式不正确。');
      if(['schedule_proposed','schedule_preview'].includes(r.stage??'')){if(r.source!=='harness')throw new Error('排程来源不正确。');checkedSchedule(r.schedule,r.stage!);}else if(r.schedule!==undefined)throw new Error('排程状态不正确。');
      if(run.busy_proposal_stale!==undefined&&typeof run.busy_proposal_stale!=='boolean')throw new Error('占用版本状态不正确。');
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
  if(code==='PLANNING_BUSY')return '当前方案正在制订，完成后可以继续补充修改。输入仍保留。';
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
