import type { AccountGoal } from './api';
import type { SlotInput } from './clarification';
export type SlotSuggestion = { key: SlotInput['key']; text: string; evidence: string };
export type DialogueReply = { schema_version: 1; kind: 'question'|'referral'; question: string; reason: string; source: 'deepseek'|'policy'; suggestions?: SlotSuggestion[] };
export type DialogueRun = { id:string;turn_index:number;user_text:string;status:'running'|'succeeded'|'failed';reply:DialogueReply|null;error_code:string|null;goal_revision?:number };
export type Dialogue = { goal:AccountGoal;chat_revision:number;runs:DialogueRun[] };
export function checkedDialogue(value: Dialogue): Dialogue {
  if(!value||!Number.isSafeInteger(value.chat_revision)||value.chat_revision<0||!Array.isArray(value.runs)||value.runs.length>30)throw new Error('对话响应格式不正确。');
  for(const run of value.runs){
    if(!run||typeof run.id!=='string'||!Number.isSafeInteger(run.turn_index)||run.turn_index<1||typeof run.user_text!=='string'||run.user_text.length>600||!['running','succeeded','failed'].includes(run.status))throw new Error('对话响应格式不正确。');
    if(run.status==='succeeded'){
      const r=run.reply;
      if(!r||r.schema_version!==1||!['question','referral'].includes(r.kind)||!['deepseek','policy'].includes(r.source)||typeof r.question!=='string'||!r.question.trim()||r.question.length>240||typeof r.reason!=='string'||r.reason.length>160||(r.kind==='question'?r.source!=='deepseek':r.source!=='policy'))throw new Error('AI 回复未通过校验。');
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
  if(code==='AI_NOT_CONFIGURED')return 'AI 服务尚未配置，请先完成服务端设置。';
  if(code==='AI_CREDENTIAL_INVALID')return 'AI 服务密钥未通过验证，请更新服务端配置。';
  if(code==='AI_BALANCE_REQUIRED')return 'AI 服务余额不足，请补充测试账户额度。';
  if(code==='AI_DAILY_LIMIT')return '今日 AI 测试额度已用完，请明天再试。';
  if(code==='AI_RATE_LIMITED')return 'AI 服务请求较多，请稍后再试。';
  if(code==='AI_INVALID_RESPONSE'||code==='AI_REPEATED_QUESTION')return 'AI 建议未通过校验，未保存回复。可查看状态后重试。';
  if(['CONTEXT_CHANGED','CONVERSATION_CHANGED','IDEMPOTENCY_CONFLICT'].includes(code))return '目标或对话已改变，请重新读取。你的输入仍保留。';
  if(code==='AI_TIMEOUT')return 'AI 生成超时，你的消息已保存。请查看状态后重试。';
  if(code==='CONTEXT_TOO_LARGE')return '当前上下文较长，请先精简目标与条件后再试。';
  return 'AI 澄清暂未完成，请查看状态后重试。';
}
