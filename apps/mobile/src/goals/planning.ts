import {checkedPlans,type PlanAttempt,type PlanSnapshot} from './plans.ts';
export type PlanningJob={id:string;source_run_id:string;goal_revision:number;status:'queued'|'deciding'|'research_ready'|'searching'|'plan_ready'|'generating'|'completed'|'failed'|'unknown';error_code:string|null;dispatched:0|1;created_at:number;plan:PlanAttempt|null};
export type PlanningSnapshot={goal:PlanSnapshot['goal'];jobs:PlanningJob[]};
export const planningActive=(j:PlanningJob)=>!['completed','failed','unknown'].includes(j.status);
export function checkedPlanning(v:PlanningSnapshot,goalId:string):PlanningSnapshot{
 if(!v?.goal||v.goal.id!==goalId||!Number.isSafeInteger(v.goal.revision)||v.goal.revision<0||!Array.isArray(v.jobs)||v.jobs.length>10||new Set(v.jobs.map(j=>j.id)).size!==v.jobs.length)throw new Error('方案进度格式不正确。');
 for(const j of v.jobs){if(!j||![j.id,j.source_run_id].every(id=>typeof id==='string'&&/^[0-9a-f-]{36}$/.test(id))||!Number.isSafeInteger(j.goal_revision)||j.goal_revision<0||!['queued','deciding','research_ready','searching','plan_ready','generating','completed','failed','unknown'].includes(j.status)||![0,1].includes(j.dispatched)||!Number.isSafeInteger(j.created_at)||j.created_at<=0||(j.error_code!==null&&typeof j.error_code!=='string')||(j.status==='completed'?(j.plan===null||j.error_code!==null):j.plan!==null))throw new Error('方案进度未通过校验。');if(j.plan){if(j.plan.id!==j.id||j.plan.goal_revision!==j.goal_revision||j.plan.context.generation_mode!=='chat_auto_v1')throw new Error('方案来源不正确。');checkedPlans({goal:v.goal,attempts:[j.plan]},goalId);}}
 return v;
}
export function planningLabel(j:PlanningJob):string{return {queued:'请求已保存，等待后台处理',deciding:'正在判断需要哪些资料',research_ready:'已确定研究方向',searching:'正在查找资料',plan_ready:'资料已准备，等待生成',generating:'正在生成并检查方案草稿',completed:'方案草稿已生成 · 待审阅',failed:'本次方案未完成',unknown:'生成结果尚不确定'}[j.status];}
