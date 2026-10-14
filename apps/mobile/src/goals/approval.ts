import {checkedPlans,type PlanDraft,type PlanContext} from './plans.ts';
import {checkedSchedule,type ScheduleData} from './schedule.ts';
export type ApprovedPlan={id:string;attempt_id:string;goal_revision:number;version:number;accepted_at:number;calendar_revision:number;context:PlanContext;draft:PlanDraft;schedule:ScheduleData};
export type ApprovalSnapshot={schema_version:1;approval:ApprovedPlan|null};
const uuid=(s:unknown)=>typeof s==='string'&&/^[0-9a-f-]{36}$/.test(s);
export function checkedApproval(value:ApprovalSnapshot,goalId:string){
 const a=value?.approval;if(value?.schema_version!==1||a===undefined)throw new Error('方案确认状态未通过校验。');
 if(!a)return value;
 if(!uuid(a.id)||!uuid(a.attempt_id)||!Number.isSafeInteger(a.goal_revision)||a.goal_revision<0||!Number.isSafeInteger(a.version)||a.version<1||!Number.isSafeInteger(a.accepted_at)||a.accepted_at<1||!Number.isSafeInteger(a.calendar_revision)||a.calendar_revision<1||a.schedule?.attempt_id!==a.attempt_id||a.schedule.goal_revision!==a.goal_revision||a.calendar_revision!==Number(a.schedule.calendar_snapshot?.revision)+1)throw new Error('方案确认回执未通过校验。');
 checkedSchedule(a.schedule,'schedule_preview');
 checkedPlans({goal:{id:goalId,revision:a.goal_revision,status:'draft'},attempts:[{id:a.attempt_id,goal_revision:a.goal_revision,status:'succeeded',error_code:null,draft:a.draft,context:a.context,billing_status:'reserved_unknown',created_at:a.accepted_at}]},goalId);
 if(a.schedule.preview?.unplaced.length||a.schedule.tasks.some(t=>!a.draft.tasks.some(d=>d.id===t.series_id&&d.title===t.title&&d.duration_minutes===t.duration_minutes)))throw new Error('已确认日程与方案不一致。');
 return value;
}

export type CalendarEntry={id:string;title:string;instructions:string;start_at:number;end_at:number;timezone:'UTC'|'Asia/Shanghai';source:'user'|'plan';goal_id:string|null;plan_version_id:string|null};
export type UpcomingCalendar={schema_version:1;from:number;to:number;revision:number;events:CalendarEntry[]};
export function checkedUpcoming(v:UpcomingCalendar,from:number,to:number){
 if(v?.schema_version!==1||v.from!==from||v.to!==to||!Number.isSafeInteger(v.revision)||v.revision<0||!Array.isArray(v.events)||v.events.length>2500||new Set(v.events.map(e=>e.id)).size!==v.events.length||v.events.some(e=>!e||!uuid(e.id)||typeof e.title!=='string'||!e.title.trim()||e.title.length>80||typeof e.instructions!=='string'||e.instructions.length>400||![e.start_at,e.end_at].every(Number.isSafeInteger)||e.end_at<=e.start_at||e.start_at>=to||e.end_at<=from||!['UTC','Asia/Shanghai'].includes(e.timezone)||(e.source==='plan'?!uuid(e.goal_id)||!uuid(e.plan_version_id)||!e.instructions.trim():e.source!=='user'||e.goal_id!==null||e.plan_version_id!==null||e.instructions!=='')))throw new Error('日历数据未通过校验。');
 return v;
}
