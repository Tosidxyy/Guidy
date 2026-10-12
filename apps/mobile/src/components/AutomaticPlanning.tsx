import {useCallback,useRef,useState} from 'react';
import {useFocusEffect} from 'expo-router';
import {Linking} from 'react-native';
import {Action,AppText,Badge,Caption,Card} from './ui';
import {getPlanning,resumePlanning} from '../goals/api';
import {planningActive,planningLabel,type PlanningSnapshot} from '../goals/planning';
import {planError} from '../goals/plans';
export function AutomaticPlanning({id,owner,chatRevision,stopped,stopRunId,onAnother}:{id:string;owner?:string;chatRevision:number;stopped:boolean;stopRunId?:string;onAnother:()=>void}){
 const [data,setData]=useState<PlanningSnapshot|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false);
 const scope=useRef(0),active=useRef(false),reading=useRef<number|null>(null);
 const read=useCallback(async(signal:AbortSignal,generation:number)=>{if(reading.current===generation)return;reading.current=generation;try{const v=await getPlanning(id,signal);if(signal.aborted||generation!==scope.current)return;setData(v);setError('');active.current=v.jobs.some(planningActive);}catch(e){if(!signal.aborted&&generation===scope.current)setError(e instanceof Error?e.message:'读取进度失败。');}finally{if(reading.current===generation)reading.current=null;}},[id]);
 useFocusEffect(useCallback(()=>{void chatRevision;const generation=++scope.current,c=new AbortController();active.current=false;if(owner)void read(c.signal,generation);const timer=setInterval(()=>{if(active.current)void read(c.signal,generation);},2500);return()=>{c.abort();scope.current++;clearInterval(timer);};},[read,owner,chatRevision]));
 const job=data?.jobs[0];const draft=job?.review?.draft??job?.plan?.draft;
 async function resume(){if(!job||busy)return;setBusy(true);setError('');const generation=scope.current;try{const v=await resumePlanning(id,job.id);if(generation!==scope.current)return;setData(v);active.current=v.jobs.some(planningActive);}catch(e){if(generation===scope.current)setError(e instanceof Error?e.message:'任务尚未启动。');}finally{setBusy(false);}}
 if(!owner)return null;
 return <>
  {!!error&&<AppText accessibilityRole="alert">{error}</AppText>}
  {stopped&&(!job||(stopRunId&&!data?.jobs.some(j=>j.source_run_id===stopRunId)))&&<Card><AppText>方案请求已保存，但尚未启动</AppText><Caption>可能已有生成任务或已达生成上限。读取状态不会重新调用AI，额度恢复后可重新提交。</Caption><Action label="读取方案进度" secondary onPress={()=>{setError('');void read(new AbortController().signal,scope.current);}}/><Action label="重新提交草稿请求" secondary disabled={busy||!!data?.jobs.some(planningActive)} onPress={()=>setConfirm(true)}/>{confirm&&<><Caption>新的请求可能再次调用AI与搜索，原请求保留。</Caption><Action label="确认重新提交" onPress={()=>{setConfirm(false);onAnother();}}/><Action label="保留当前请求" secondary onPress={()=>setConfirm(false)}/></>}</Card>}
  {job&&<Card><Badge>{planningLabel(job)}</Badge>
   {job.goal_revision!==data!.goal.revision&&<Caption>这是旧目标版本的请求，结果仅供参考。</Caption>}
   {job.error_code&&<Caption>{job.error_code==='WORKFLOW_START_FAILED'?'后台任务尚未成功启动，可恢复同一请求。':planError(job.error_code)}</Caption>}
   {job.status==='queued'&&job.dispatched===0&&<Action label={busy?'正在恢复…':'恢复本次后台任务'} secondary disabled={busy} onPress={()=>{void resume();}}/>}
   {planningActive(job)&&<Caption>可以离开，重进后恢复后台进度。不会写入日历。</Caption>}
   {job.plan&&draft&&<>
    {job.review&&<Caption>已采用审阅版本 {job.review.revision}，AI原稿保留。</Caption>}
    <AppText>{draft!.title}</AppText><AppText>{job.plan.draft!.summary}</AppText><Caption>预计每周 {job.plan.draft!.weekly_minutes} 分钟 · 内容尚未核实，时间、成本和排程仍待检查。</Caption>
    {job.plan.draft!.assumptions.map((s,i)=><Caption key={`a${i}`}>待核对：{s}</Caption>)}
    {job.plan.draft!.tasks.map((t,index)=><Card key={t.id}><AppText>第 {index+1} 项 · {t.title}</AppText><Caption>{t.instructions}</Caption><Caption>阶段 {t.stage} · 每次 {t.duration_minutes} 分钟 · 每周 {t.frequency_per_week} 次</Caption>{!!t.depends_on.length&&<Caption>前置：{t.depends_on.map(dep=>job.plan!.draft!.tasks.find(parent=>parent.id===dep)?.title).join('、')}</Caption>}{t.evidence_ids.map(ref=><Caption key={ref}>依据：{job.plan!.context.sources.find(s=>s.source_id===ref)?.title}</Caption>)}</Card>)}
    {job.plan.draft!.risks.map((s,i)=><Caption key={`r${i}`}>限制：{s}</Caption>)}
    {job.plan.context.sources.map(s=><Action key={s.source_id} label={`查看资料：${s.title}`} secondary onPress={()=>{void Linking.openURL(s.url).catch(()=>setError('原资料未能打开。'));}}/>)}
    <Caption>你可以继续描述希望如何调整；可以说「把第一项改成每次15分钟，每周4次」调整投入；步骤内容改写和确认入历仍在开发。</Caption>
   </>}
   {!planningActive(job)&&<><Action label="另生成一份草稿" secondary disabled={busy} onPress={()=>setConfirm(true)}/>{confirm&&<><Caption>这会创建新的请求，可能再次调用AI与搜索，已有草稿保留。</Caption><Action label="确认另生成" onPress={()=>{setConfirm(false);onAnother();}}/><Action label="保留当前结果" secondary onPress={()=>setConfirm(false)}/></>}</>}
  </Card>}
 </>;
}
