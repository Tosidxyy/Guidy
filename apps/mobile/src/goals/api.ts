import {checkedPlanning,type PlanningSnapshot} from './planning';
import { checkedPlans,planError,checkedReviews,reviewError,type ReviewSnapshot,type ReviewChange,type PlanSnapshot } from './plans';
import { checkedSearchSnapshot, searchError, type SearchSnapshot } from './search';
import { Platform } from 'react-native';
import { apiOrigin, authClient } from '../auth/client';
import { checkedSlots, type SavedSlot, type SlotInput } from './clarification';
import { checkedDialogue, dialogueError, type Dialogue } from './dialogue';
import { checkedReadiness, type Readiness } from './readiness';
import { checkedEvidence, checkedJobs, jobError, sourceError, type Evidence, type ResearchJob } from './research';

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
  const timer = setTimeout(cancel, path.endsWith('/plan-drafts') ? 40_000 : path.endsWith('/messages')||path.endsWith('/evidence')||path.endsWith('/research-runs')||path.endsWith('/search-runs') ? 30_000 : 10_000);
  try {
    const response = await fetch(`${apiOrigin}/api/v1/goals${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: Platform.OS === 'web' ? 'include' : 'omit', signal: controller.signal });
    const payload = await response.json();
    if (!response.ok) {
      if(path.includes('/draft-reviews?')&&response.status!==401&&response.status!==404)throw new GoalApiError(reviewError(payload.error?.code??''),payload.error?.code??'REVIEW_UNAVAILABLE');
      if(path.endsWith('/plan-drafts')&&response.status!==401&&response.status!==404)throw new GoalApiError(planError(payload.error?.code??''),payload.error?.code??'PLAN_RESULT_UNKNOWN');
      if(path.endsWith('/search-runs')&&response.status!==401&&response.status!==404)throw new GoalApiError(searchError(payload.error?.code??''),payload.error?.code??'SEARCH_RESULT_UNKNOWN');
      if(path.endsWith('/messages') && response.status!==401 && response.status!==404)throw new GoalApiError(dialogueError(payload.error?.code??''),payload.error?.code??'AI_UNAVAILABLE');
      if((path.endsWith('/evidence')||path.endsWith('/research-runs'))&&response.status!==401&&response.status!==404){const code=payload.error?.code??'SOURCE_UNAVAILABLE';throw new GoalApiError(path.endsWith('/evidence')?sourceError(code):jobError(code),code);}
      if (response.status === 401) throw new Error('登录已失效，请重新登录。请求失败不会清空输入。');
      if (response.status === 409) throw new GoalApiError('目标已改变，请读取最新版本后再决定是否保存。你的输入仍保留。', payload.error?.code ?? 'CONFLICT');
      if (response.status === 404) throw new Error('目标不存在或当前账号无法访问。');
      throw new Error('账号目标未保存或读取成功，请稍后重试。');
    }
    if (payload.error !== null || !payload.data) throw new Error('服务响应格式不正确。');
    return payload.data;
  } catch (error) {
    if(path.endsWith('/plan-drafts')&&(controller.signal.aborted||!(error instanceof Error)||error.name==='TypeError'))throw new Error('草稿连接中断，结果可能已保存。请先读取状态或恢复同一请求，不会自动重新生成。');
    if(path.endsWith('/search-runs')&&(controller.signal.aborted||!(error instanceof Error)||error.name==='TypeError'))throw new Error('搜索连接中断，结果可能已保存。请先读取状态或恢复同一请求，不会自动重新搜索。');
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
  return result;
}

function checkedGoal(result: AccountGoal): AccountGoal {
  if (!result || !/^[0-9a-f-]{36}$/.test(result.id) || typeof result.title !== 'string' || typeof result.description !== 'string' || typeof result.timeframe_note !== 'string' || typeof result.status !== 'string' || !Number.isSafeInteger(result.revision) || result.revision < 0) throw new Error('目标响应格式不正确。');
  return result;
}
export async function getGoal(id: string, signal: AbortSignal): Promise<AccountGoal> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('目标地址不正确。');
  return checkedGoal(await request('GET', undefined, undefined, signal, `/${id}`));
}
export async function updateGoal(id: string, body: { description: string; timeframe: string; status: 'draft' | 'paused'; expected_revision: number }, key: string): Promise<AccountGoal> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('目标地址不正确。');
  return checkedGoal(await request('PATCH', body, key, undefined, `/${id}`));
}

export type GoalConditions = { goal: AccountGoal; slots: SavedSlot[]; readiness?: Readiness };
function checkedConditions(result: GoalConditions): GoalConditions {
  if (!result) throw new Error('条件响应格式不正确。');
  const goal=checkedGoal(result.goal);
  return { goal, slots: checkedSlots(result.slots), readiness: result.readiness===undefined?undefined:checkedReadiness(result.readiness,goal.revision) };
}
export async function getConditions(id: string, signal: AbortSignal): Promise<GoalConditions> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('目标地址不正确。');
  return checkedConditions(await request('GET', undefined, undefined, signal, `/${id}/slots`));
}
export async function saveConditions(id: string, body: { expected_revision: number; slots: SlotInput[] }, key: string): Promise<GoalConditions> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('目标地址不正确。');
  return checkedConditions(await request('PATCH', body, key, undefined, `/${id}/slots`));
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
export type Research = {goal:AccountGoal;evidence:Evidence[]};
function checkedResearch(result:Research):Research{return {goal:checkedGoal(result.goal),evidence:checkedEvidence(result.evidence)};}
export async function getResearch(id:string,signal:AbortSignal):Promise<Research>{if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('目标地址不正确。');return checkedResearch(await request('GET',undefined,undefined,signal,`/${id}/evidence`));}
export async function addSource(id:string,body:{url:string;claim:string;caveat:string;expected_revision:number},key:string):Promise<Research>{
  if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('目标地址不正确。');
  try{return checkedResearch(await request('POST',body,key,undefined,`/${id}/evidence`));}
  catch(error){if(error instanceof GoalApiError&&error.code.startsWith('SOURCE_'))throw new Error(sourceError(error.code));throw error;}
}
export type ResearchJobs={goal:AccountGoal;jobs:ResearchJob[]};
function checkedJobResult(result:ResearchJobs):ResearchJobs{return {goal:checkedGoal(result.goal),jobs:checkedJobs(result.jobs)};}
export async function getResearchJobs(id:string,signal:AbortSignal):Promise<ResearchJobs>{
  if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('目标地址不正确。');
  return checkedJobResult(await request('GET',undefined,undefined,signal,`/${id}/research-runs`));
}
export async function submitResearchJob(id:string,body:{evidence_ids:string[];expected_revision:number}|{resume_job_id:string},key?:string):Promise<ResearchJobs>{
  if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('目标地址不正确。');
  try{return checkedJobResult(await request('POST',body,key,undefined,`/${id}/research-runs`));}catch(error){if(error instanceof GoalApiError)throw new Error(jobError(error.code));throw error;}
}

export async function getSearch(id:string,signal:AbortSignal):Promise<SearchSnapshot>{if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('目标地址不正确。');return checkedSearchSnapshot(await request('GET',undefined,undefined,signal,`/${id}/search-runs`),id);}
export async function submitSearch(id:string,body:{query:string;expected_revision:number},key:string):Promise<SearchSnapshot>{if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('目标地址不正确。');return checkedSearchSnapshot(await request('POST',body,key,undefined,`/${id}/search-runs`),id);}

export async function getPlans(id:string,signal:AbortSignal):Promise<PlanSnapshot>{if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('目标地址不正确。');return checkedPlans(await request('GET',undefined,undefined,signal,`/${id}/plan-drafts`),id);}
export async function submitPlan(id:string,body:{search_ids:string[];expected_revision:number},key:string):Promise<PlanSnapshot>{if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('目标地址不正确。');return checkedPlans(await request('POST',body,key,undefined,`/${id}/plan-drafts`),id);}

export async function getReviews(id:string,attemptId:string,signal:AbortSignal):Promise<ReviewSnapshot>{if(!/^[0-9a-f-]{36}$/.test(id)||!/^[0-9a-f-]{36}$/.test(attemptId))throw new Error('草稿地址不正确。');return checkedReviews(await request('GET',undefined,undefined,signal,`/${id}/draft-reviews?attempt_id=${attemptId}`),id,attemptId);}
export async function saveReview(id:string,attemptId:string,body:{expected_goal_revision:number;expected_review_revision:number;weekly_capacity_minutes?:number|null;proposal_run_id?:string;changes:ReviewChange[]},key:string):Promise<ReviewSnapshot>{if(!/^[0-9a-f-]{36}$/.test(id)||!/^[0-9a-f-]{36}$/.test(attemptId))throw new Error('草稿地址不正确。');return checkedReviews(await request('POST',body,key,undefined,`/${id}/draft-reviews?attempt_id=${attemptId}`),id,attemptId);}

export async function getPlanning(id:string,signal?:AbortSignal):Promise<PlanningSnapshot>{return checkedPlanning(await request('GET',undefined,undefined,signal,`/${id}/planning-runs`),id);}
export async function resumePlanning(id:string,jobId:string):Promise<PlanningSnapshot>{return checkedPlanning(await request('POST',{job_id:jobId},undefined,undefined,`/${id}/planning-runs`),id);}
