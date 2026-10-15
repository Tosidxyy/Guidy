import type {ApprovedPlan} from '../goals/approval';
import {View,AppState} from 'react-native';
import {candidateExpired,candidateKeyCurrent,planningDay} from '../goals/candidate-expiry';
import {PlanCalendar} from './PlanCalendar';
import type {ScheduleData} from '../goals/schedule';
import {useCallback,useRef,useState,useEffect} from 'react';
import {useFocusEffect} from 'expo-router';

import {Action,AppText,Badge,Caption,Card} from './ui';
import {getPlanning,resumePlanning,getApproval,approvePlan,GoalApiError} from '../goals/api';
import {planningActive,planningLabel,type PlanningSnapshot} from '../goals/planning';
import {planError} from '../goals/plans';
export function AutomaticPlanning({id,owner,calendarRevision,automaticScheduleKey,automaticSchedule,automaticScheduleRunId,onRefresh,onAutoSchedule,chatRevision,stopped,stopRunId,onAnother,canSchedule}:{id:string;owner?:string;calendarRevision?:number;automaticScheduleKey?:string|null;automaticSchedule?:ScheduleData|null;automaticScheduleRunId?:string|null;onRefresh:()=>void;onAutoSchedule:(key:string)=>void;chatRevision:number;stopped:boolean;stopRunId?:string;onAnother:()=>void;canSchedule:boolean}){
 const [now,setNow]=useState(Date.now);const refresh=useRef(onRefresh);useEffect(()=>{refresh.current=onRefresh;},[onRefresh]);
 useFocusEffect(useCallback(()=>{setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),30000);const subscription=AppState.addEventListener('change',state=>{if(state==='active'){setNow(Date.now());refresh.current();}});return()=>{clearInterval(timer);subscription.remove();};},[]));
 const [approved,setApproved]=useState<ApprovedPlan|null>(null),[approving,setApproving]=useState(false);const approvalLock=useRef(false);
 const [data,setData]=useState<PlanningSnapshot|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false),[loading,setLoading]=useState(false);
 const scope=useRef(0),active=useRef(false),reading=useRef<number|null>(null),focusSignal=useRef<AbortSignal|null>(null);
 const read=useCallback(async(signal:AbortSignal,generation:number)=>{if(reading.current===generation)return;reading.current=generation;setLoading(true);try{const [v,a]=await Promise.all([getPlanning(id,signal),getApproval(id,signal)]);if(signal.aborted||generation!==scope.current)return;setData(v);setApproved(a.approval);setError('');active.current=v.jobs.some(planningActive);if(v.jobs[0]?.plan&&v.jobs[0].goal_revision===v.goal.revision&&a.approval?.attempt_id!==v.jobs[0].id&&automaticScheduleKey===null)refresh.current();}catch(e){if(!signal.aborted&&generation===scope.current)setError(e instanceof Error?e.message:'读取进度失败。');}finally{if(reading.current===generation)reading.current=null;if(generation===scope.current)setLoading(false);}},[id,automaticScheduleKey]);
 useFocusEffect(useCallback(()=>{void chatRevision;void calendarRevision;void automaticScheduleKey;const generation=++scope.current,c=new AbortController();focusSignal.current=c.signal;active.current=false;if(owner)void read(c.signal,generation);const timer=setInterval(()=>{if(active.current)void read(c.signal,generation);},2500);return()=>{c.abort();focusSignal.current=null;scope.current++;clearInterval(timer);};},[read,owner,chatRevision,calendarRevision,automaticScheduleKey]));
 const attempted=useRef<string|null>(null);
 const job=data?.jobs[0];const draft=approved&&approved.attempt_id===job?.id?approved.draft:job?.review?.draft??job?.plan?.draft;
 const requestWaiting=!!stopped&&(!job||!!stopRunId&&!data?.jobs.some(j=>j.source_run_id===stopRunId));
 const previousJob=job&&!job.plan?data?.jobs.find(j=>!!j.plan):undefined;
 const autoKey=automaticScheduleKey!==undefined?automaticScheduleKey:job?.plan&&calendarRevision!==undefined?`auto_schedule_${job.id}_${job.review?.revision??0}_${calendarRevision}`:null;
 const candidateTimezone=draft?.time_preferences?.timezone??automaticSchedule?.timezone??'Asia/Shanghai';
 const pending=!!approved&&automaticSchedule?.replaces_plan_id===approved.id;
 const accepted=approved?.attempt_id===job?.id&&!pending?approved:null;const displayed=accepted?.schedule??automaticSchedule;
 const expired=!!automaticSchedule&&!accepted&&candidateExpired(automaticSchedule,now);
 const matching=!expired&&!!automaticSchedule&&automaticSchedule.attempt_id===job?.id&&automaticSchedule.review_revision===(job.review?.revision??0)&&automaticSchedule.calendar_snapshot?.revision===calendarRevision&&automaticSchedule.goal_revision===data?.goal.revision;
 useEffect(()=>{if(['draft','active'].includes(data?.goal.status??'')&&autoKey&&(!expired||candidateKeyCurrent(autoKey,candidateTimezone,now))&&!accepted&&!matching&&canSchedule&&!loading&&!error&&job?.goal_revision===data?.goal.revision&&attempted.current!==autoKey){attempted.current=autoKey;onAutoSchedule(autoKey);}},[autoKey,candidateTimezone,accepted,matching,canSchedule,loading,error,expired,now,automaticSchedule?.timezone,job?.goal_revision,data?.goal.revision,data?.goal.status,onAutoSchedule]);
 const expiryRead=useRef<string|null>(null);
 useEffect(()=>{if(!expired||!automaticSchedule)return;const tag=String(automaticScheduleRunId)+'_'+planningDay(automaticSchedule.timezone,now);if(['draft','active'].includes(data?.goal.status??'')&&autoKey&&!candidateKeyCurrent(autoKey,candidateTimezone,now)&&expiryRead.current!==tag){expiryRead.current=tag;refresh.current();}if(data?.goal.status==='active'&&pending&&automaticSchedule.scope==='remaining_plan_v1'&&canSchedule&&!loading&&!error){const key='refresh_replan_'+tag;if(attempted.current!==key){attempted.current=key;onAutoSchedule(key);}}},[expired,candidateTimezone,automaticSchedule,automaticScheduleRunId,now,data?.goal.status,autoKey,pending,canSchedule,loading,error,onAutoSchedule]);
 async function resume(){if(!job||busy)return;setBusy(true);setError('');const generation=scope.current;try{const v=await resumePlanning(id,job.id);if(generation!==scope.current)return;setData(v);active.current=v.jobs.some(planningActive);}catch(e){if(generation===scope.current)setError(e instanceof Error?e.message:'任务尚未启动。');}finally{setBusy(false);}}
 async function accept(){if(approvalLock.current||!automaticScheduleRunId||!automaticSchedule||!data)return;approvalLock.current=true;setApproving(true);setError('');const generation=scope.current;try{const value=await approvePlan(id,{schedule_run_id:automaticScheduleRunId,expected_goal_revision:data.goal.revision,expected_calendar_revision:automaticSchedule.calendar_snapshot!.revision},'approve_'+automaticScheduleRunId);if(generation===scope.current){setApproved(value.approval);onRefresh();}}catch(e){if(generation===scope.current){setError(e instanceof Error?e.message:'确认状态尚未取得。');try{const value=await getApproval(id);if(generation===scope.current&&value.approval?.attempt_id===job?.id){setApproved(value.approval);setError('');onRefresh();}}catch{/* Keep verified preview; recover by reading, never silently confirm again. */}if(e instanceof GoalApiError&&['CALENDAR_CHANGED','SCHEDULE_EXPIRED'].includes(e.code)){setNow(Date.now());onRefresh();}}}finally{approvalLock.current=false;setApproving(false);}}
 if(!owner)return null;
 return <>
  {!!error&&<Card><AppText accessibilityRole="alert">{job?.plan?"更新状态暂未成功，已读取的草稿仍保留。":"方案状态暂未读取成功。"}</AppText><Caption>{error}</Caption><Action label="重新读取方案状态" secondary disabled={loading||busy} onPress={()=>{if(focusSignal.current)void read(focusSignal.current,scope.current);}}/></Card>}
  {stopped&&(!job||(stopRunId&&!data?.jobs.some(j=>j.source_run_id===stopRunId)))&&<Card><AppText>方案请求已保存，但尚未启动</AppText><Caption>可能已有生成任务或已达生成上限。读取状态不会重新调用AI，额度恢复后可重新提交。</Caption><Action label="读取方案进度" secondary onPress={()=>{setError('');void read(new AbortController().signal,scope.current);}}/><Action label="重新提交草稿请求" secondary disabled={busy||loading||!!error||!!data?.jobs.some(planningActive)} onPress={()=>setConfirm(true)}/>{confirm&&<><Caption>新的请求可能再次调用AI与搜索，原请求保留。</Caption><Action label="确认重新提交" disabled={busy||loading||!!error} onPress={()=>{setConfirm(false);onAnother();}}/><Action label="保留当前请求" secondary onPress={()=>setConfirm(false)}/></>}</Card>}
  {job&&<View style={{gap:20}}>{!job.plan&&<Badge>{planningLabel(job)}</Badge>}
   {!accepted&&!pending&&job.goal_revision!==data!.goal.revision&&<Caption>这是旧目标版本的请求，结果仅供参考。</Caption>}
   {job.error_code&&<Caption>{job.error_code==='WORKFLOW_START_FAILED'?'后台任务尚未成功启动，可恢复同一请求。':planError(job.error_code)}</Caption>}
   {job.status==='queued'&&job.dispatched===0&&<Action label={busy?'正在恢复…':'恢复本次后台任务'} secondary disabled={busy} onPress={()=>{void resume();}}/>}
   {planningActive(job)&&<Caption>可以离开，重进后恢复后台进度。不会写入日历。</Caption>}
   {job.plan&&draft&&<>
    <AppText style={{fontSize:24,fontWeight:'600'}}>{draft!.title}</AppText><Caption>{draft!.summary}</Caption>
    {pending&&matching&&<Caption>确认后只替换未来尚未执行的安排，已完成、跳过和过去的记录仍保留。</Caption>}
    {(accepted||matching)&&displayed&&<PlanCalendar approved={!!accepted} schedule={displayed} instructions={taskId=>draft!.tasks.find(t=>t.id===taskId)?.instructions}/>}
    {!!accepted&&<Caption>方案已确认，日历中可查看每日安排。</Caption>}
    {!accepted&&matching&&!requestWaiting&&<Action label={approving?'正在加入日历…':pending?'确认调整并更新日历':'确认方案并加入日历'} disabled={approving||loading||!!error||!canSchedule||!automaticScheduleRunId||!!automaticSchedule?.preview?.unplaced.length} onPress={()=>{void accept();}}/>}
    {draft!.risks.map((risk,i)=><Caption key={`risk-${i}`}>需留意：{risk}</Caption>)}
    {draft!.assumptions.map((assumption,i)=><Caption key={`assumption-${i}`}>待核对：{assumption}</Caption>)}    {!accepted&&!matching&&<><Caption>{expired?'正在更新已过期的日期建议，原方案保留；不会调用 AI。':'正在准备日历建议；你也可以继续补充偏好。'}</Caption><Action label="重新准备建议日程" secondary disabled={!canSchedule||loading||(!pending&&!autoKey)||(expired&&!pending&&!!autoKey&&!candidateKeyCurrent(autoKey,candidateTimezone,now))} onPress={()=>{if(pending&&automaticSchedule?.scope==='remaining_plan_v1')onAutoSchedule('refresh_replan_'+automaticScheduleRunId+'_'+planningDay(automaticSchedule?.timezone??'Asia/Shanghai',now));else if(autoKey)onAutoSchedule(autoKey);}}/></>}

   </>}
  </View>}
  {previousJob?.plan&&<Card><AppText style={{fontSize:20,fontWeight:'600'}}>{approved?'当前已确认方案仍保留':'上次方案仍保留 · 仅回看'}</AppText><AppText>{(approved?.draft??previousJob.plan.draft!).title}</AppText><Caption>{(approved?.draft??previousJob.plan.draft!).summary}</Caption>{(!!approved||automaticSchedule?.attempt_id===previousJob.id)&&<PlanCalendar approved={!!approved} schedule={(approved?.schedule??automaticSchedule)!} instructions={taskId=>(approved?.draft??previousJob.plan!.draft!).tasks.find(t=>t.id===taskId)?.instructions}/>}</Card>}
 </>;
}
