import {checkedHistory,type QuestionHistory} from './question-history';
import {checkedApproval,checkedUpcoming,type ApprovalSnapshot,type UpcomingCalendar} from './approval';
import {requestTimeout,PLANNING_READ_INTERRUPTED} from './request-policy';
import {checkedPlanning,type PlanningSnapshot} from './planning';
import { Platform } from 'react-native';
import { apiOrigin, authClient } from '../auth/client';
import { checkedDialogue, dialogueError, type Dialogue } from './dialogue';

export type AccountGoal = { id: string; title: string; description: string; timeframe_note: string; status: string; revision: number };
export class GoalApiError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}
async function request(method: 'GET' | 'POST' | 'PATCH', body?: Record<string, unknown>, key?: string, signal?: AbortSignal, path = '') {
  if (!apiOrigin || !authClient) throw new Error('请先配置服务地址。');
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  if (Platform.OS !== 'web') { headers.Cookie = await authClient.getCookie(); headers['expo-origin'] = 'guidy://'; }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(cancel, requestTimeout(path));
  try {
    const response = await fetch(path.startsWith('/api/v1/calendar/')?`${apiOrigin}${path}`:`${apiOrigin}/api/v1/goals${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: Platform.OS === 'web' ? 'include' : 'omit', signal: controller.signal });
    const payload = await response.json();
    if (!response.ok) {
      if(path.includes('/question-history')&&![401,404].includes(response.status))throw new Error('回答历史未能读取，请稍后重试。');
      if(path.endsWith('/plan-approval')&&![401,404].includes(response.status)){const code=payload.error?.code;throw new GoalApiError(code==='CALENDAR_CHANGED'?'日历已有变化，请更新建议安排。':code==='SCHEDULE_EXPIRED'?'建议时间已过去，请更新日程。':code==='PLAN_NOT_READY'?'仍有任务需要调整，确认前请核对完整方案。':'方案确认未完成，请读取最新状态后再试。',code??'APPROVAL_FAILED');}
      if(path.startsWith('/api/v1/calendar/')&&response.status!==401&&method==='GET')throw new Error('日历未能读取，请稍后重试。');
      if(path.startsWith('/api/v1/calendar/')&&response.status!==401)throw new GoalApiError(payload.error?.code==='EVENT_CONFLICT'?'这个时间已有安排，请换一个时间。':payload.error?.code==='CALENDAR_CHANGED'?'日历已变化，请刷新后再确认。':'日程未保存，请核对日期与时间。',payload.error?.code??'CALENDAR_FAILED');
      if(path.endsWith('/conversation')&&response.status!==401&&response.status!==404)throw new GoalApiError(payload.error?.code==='DISCUSSION_LIMIT_OR_BUSY'?'当前有讨论正在处理，或今日讨论次数已用完。':payload.error?.code==='AI_TIMEOUT'?'回复暂未完成，消息已保留。':'这次回复未能完成，请重试。',payload.error?.code??'AI_UNAVAILABLE');
      if(path.endsWith('/messages') && response.status!==401 && response.status!==404)throw new GoalApiError(dialogueError(payload.error?.code??''),payload.error?.code??'AI_UNAVAILABLE');
      if (response.status === 401) throw new Error('登录已失效，请重新登录。请求失败不会清空输入。');
      if (response.status === 409) throw new GoalApiError('目标已改变，请读取最新版本后再决定是否保存。你的输入仍保留。', payload.error?.code ?? 'CONFLICT');
      if (response.status === 404) throw new Error('目标不存在或当前账号无法访问。');
      throw new Error('账号目标未保存或读取成功，请稍后重试。');
    }
    if (payload.error !== null || !payload.data) throw new Error('服务响应格式不正确。');
    return payload.data;
  } catch (error) {
    if(path.endsWith('/planning-runs')&&(controller.signal.aborted||!(error instanceof Error)||error.name==='TypeError'))throw new Error(PLANNING_READ_INTERRUPTED);
    if (controller.signal.aborted) throw new Error('连接超时或已取消，输入未清空，请重试。');
    if (error instanceof Error && !['TypeError'].includes(error.name)) throw error;
    throw new Error('无法连接服务，输入未清空，请重试。');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
export async function listGoals(signal: AbortSignal): Promise<{ goals: AccountGoal[]; has_more: boolean }> {
  const result = await request('GET', undefined, undefined, signal);
  if (!Array.isArray(result.goals) || typeof result.has_more !== 'boolean' || result.goals.some((g: AccountGoal) => !g || typeof g.id !== 'string' || typeof g.description !== 'string' || typeof g.title !== 'string' || typeof g.timeframe_note !== 'string' || typeof g.status !== 'string' || !Number.isInteger(g.revision))) throw new Error('目标列表格式不正确。');
  return result;
}
export async function createGoal(body: { description: string; timeframe: string }, key: string): Promise<AccountGoal> {
  const result = await request('POST', body, key);
  if (typeof result.id !== 'string' || result.status !== 'draft' || result.description !== body.description || result.timeframe_note !== body.timeframe || !Number.isInteger(result.revision)) throw new Error('目标保存结果未确认。本机草稿仍保留，请重试。');
  return checkedGoal(result);
}

function checkedGoal(result: AccountGoal): AccountGoal {
  if (!result || !/^[0-9a-f-]{36}$/.test(result.id) || typeof result.title !== 'string' || typeof result.description !== 'string' || typeof result.timeframe_note !== 'string' || typeof result.status !== 'string' || !Number.isSafeInteger(result.revision) || result.revision < 0) throw new Error('目标响应格式不正确。');
  return result;
}
export async function getGoal(id: string, signal: AbortSignal): Promise<AccountGoal> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('目标地址不正确。');
  return checkedGoal(await request('GET', undefined, undefined, signal, `/${id}`));
}
export async function setGoalStatus(id: string, body: { status: 'draft' | 'paused'; expected_revision: number }, key: string): Promise<AccountGoal> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('目标地址不正确。');
  return checkedGoal(await request('PATCH', body, key, undefined, `/${id}`));
}

export async function getDialogue(id:string,signal:AbortSignal):Promise<Dialogue>{
  if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('目标地址不正确。');
  const data=checkedDialogue(await request('GET',undefined,undefined,signal,`/${id}/messages`));
  return {...data,goal:checkedGoal(data.goal)};
}
export async function sendDialogue(id:string,body:{text:string;expected_chat_revision:number;expected_goal_revision:number},key:string):Promise<Dialogue>{
  if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('目标地址不正确。');
  const data=checkedDialogue(await request('POST',body,key,undefined,`/${id}/messages`));
  return {...data,goal:checkedGoal(data.goal)};
}
export async function getPlanning(id:string,signal?:AbortSignal):Promise<PlanningSnapshot>{return checkedPlanning(await request('GET',undefined,undefined,signal,`/${id}/planning-runs`),id);}
export async function resumePlanning(id:string,jobId:string):Promise<PlanningSnapshot>{return checkedPlanning(await request('POST',{job_id:jobId},undefined,undefined,`/${id}/planning-runs`),id);}


export async function getApproval(id:string,signal?:AbortSignal):Promise<ApprovalSnapshot>{return checkedApproval(await request('GET',undefined,undefined,signal,`/${id}/plan-approval`),id);}
export async function approvePlan(id:string,body:{schedule_run_id:string;expected_goal_revision:number;expected_calendar_revision:number},key:string):Promise<ApprovalSnapshot>{return checkedApproval(await request('POST',body,key,undefined,`/${id}/plan-approval`),id);}
export async function getUpcomingCalendar(from:number,to:number,signal:AbortSignal):Promise<UpcomingCalendar>{return checkedUpcoming(await request('GET',undefined,undefined,signal,'/api/v1/calendar/events?from='+from+'&to='+to),from,to);}

export async function getQuestionHistory(id:string,before?:number,signal?:AbortSignal):Promise<QuestionHistory>{if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('目标地址不正确。');return checkedHistory(await request('GET',undefined,undefined,signal,`/${id}/question-history${before===undefined?'':'?before='+before}`),id,before);}

export type EventInput={title:string;start_at:number;end_at:number;timezone:'Asia/Shanghai'|'UTC'};
export type DiscussionTurn={saved_event_id?:string|null;id:string;user_text:string;status:'running'|'succeeded'|'failed';goal_revision:number;reply:{kind:'reply'|'event'|'revision';message:string;event:EventInput|null;revision:string|null}|null};
function checkedDiscussion(v:{turns:DiscussionTurn[]}){if(!v||!Array.isArray(v.turns)||v.turns.length>60||v.turns.some(t=>!t||typeof t.id!=='string'||typeof t.user_text!=='string'||!['running','succeeded','failed'].includes(t.status)||(t.status==='succeeded'&&(!t.reply||typeof t.reply.message!=='string'||t.reply.message.length>240||!['reply','event','revision'].includes(t.reply.kind)))))throw new Error('讨论记录格式不正确。');return v.turns;}
export async function getDiscussion(id:string,signal?:AbortSignal){return checkedDiscussion(await request('GET',undefined,undefined,signal,'/'+id+'/conversation'));}
export async function discuss(id:string,text:string,revision:number,key:string){return checkedDiscussion(await request('POST',{text,expected_goal_revision:revision},key,undefined,'/'+id+'/conversation'));}
export async function createCalendarEvent(event:EventInput,revision:number,key:string,proposalId?:string){const r=await request('POST',{event,expected_revision:revision,...(proposalId?{proposal_id:proposalId}:{})},key,undefined,'/api/v1/calendar/events');if(!r.event||typeof r.event.id!=='string'||!Number.isSafeInteger(r.revision))throw new Error('日程保存状态待确认，请重新读取。');return r as {event:EventInput&{id:string};revision:number};}
