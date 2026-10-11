import { useCallback,useRef,useState } from 'react';
import { router,useFocusEffect,useLocalSearchParams } from 'expo-router';
import { Linking } from 'react-native';
import { Action,AppText,Badge,Caption,Card,Screen } from '../../../src/components/ui';
import { useAccount } from '../../../src/auth/AuthProvider';
import { getPlans,getSearch,submitPlan } from '../../../src/goals/api';
import { planError,type PlanSnapshot } from '../../../src/goals/plans';
import type { SearchSnapshot } from '../../../src/goals/search';
function requestKey(){return `plan_${Date.now()}_${Math.random().toString(36).slice(2,12)}`;}
export default function PlanPage(){const {id}=useLocalSearchParams<{id:string}>();const {user}=useAccount();return <PlanBody key={`${user?.id??''}:${id}`} id={id} owner={user?.id}/>;}
function PlanBody({id,owner}:{id:string;owner?:string}){
 const [data,setData]=useState<PlanSnapshot|null>(null),[search,setSearch]=useState<SearchSnapshot|null>(null),[selected,setSelected]=useState<string[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reading,setReading]=useState(false),[refresh,setRefresh]=useState(0),[hasOperation,setHasOperation]=useState(false),[confirm,setConfirm]=useState(false),[ended,setEnded]=useState(false);
 const scope=useRef(0),lock=useRef(false),operation=useRef<{search_ids:string[];expected_revision:number;key:string;knownIds:string[];attemptId?:string}|null>(null);
 function receipt(value:PlanSnapshot){const op=operation.current;if(!op)return;const a=value.attempts.find(a=>op.attemptId?a.id===op.attemptId:a.goal_revision===op.expected_revision&&!op.knownIds.includes(a.id));if(a){op.attemptId=a.id;setEnded(a.status==='succeeded'||a.status==='failed');}}
 const read=useCallback(async(signal:AbortSignal,generation:number)=>{setReading(true);try{const [plans,sources]=await Promise.all([getPlans(id,signal),getSearch(id,signal)]);if(signal.aborted||generation!==scope.current)return;if(plans.goal.revision!==sources.goal.revision)throw new Error('目标版本变化，请重新读取。');setData(plans);setSearch(sources);receipt(plans);}catch(err){if(!signal.aborted&&generation===scope.current)setError(err instanceof Error?err.message:'读取失败。');}finally{if(generation===scope.current)setReading(false);}},[id]);
 useFocusEffect(useCallback(()=>{void refresh;const generation=++scope.current,controller=new AbortController();setData(null);setSearch(null);if(owner)void read(controller.signal,generation);return()=>{controller.abort();scope.current++;};},[owner,refresh,read]));
 const eligible=search?.attempts.filter(a=>a.goal_revision===search.goal.revision&&a.status==='succeeded'&&a.result?.sources.some(s=>s.content&&s.content_kind!=='snippet_only'))??[];
 const active=data?.attempts.some(a=>a.status==='submitted');
 async function generate(){if(!data||lock.current||reading||data.goal.status!=='draft'||(active&&!operation.current))return;if(!operation.current){if(!selected.length||selected.some(id=>!eligible.some(a=>a.id===id))){setError('请选择当前版本有正文或摘要的搜索资料。');return;}operation.current={search_ids:[...selected].sort(),expected_revision:data.goal.revision,key:requestKey(),knownIds:data.attempts.map(a=>a.id)};}setHasOperation(true);const op=operation.current,generation=scope.current;lock.current=true;setBusy(true);setError('');try{const value=await submitPlan(id,{search_ids:op.search_ids,expected_revision:op.expected_revision},op.key);if(generation!==scope.current)return;setData(value);receipt(value);}catch(err){if(generation!==scope.current)return;setError(err instanceof Error?err.message:'草稿状态不明。');await read(new AbortController().signal,generation);}finally{lock.current=false;setBusy(false);}}
 return <Screen title="计划草稿" bottomInset>
  <Action label="返回搜索资料" secondary disabled={busy} onPress={()=>router.replace({pathname:'/goal/[id]/search',params:{id}})}/>
  <Badge>待审阅建议 · 尚未确认</Badge><Caption>根据已确认条件与搜索资料生成建议。引用仍未核实，时间与成本需要核对；不会写入日历。</Caption>
  {!!error&&<AppText accessibilityRole="alert">{error}</AppText>}{!owner&&<Caption>请登录后查看草稿。</Caption>}
  {owner&&<Action label={reading?'正在读取草稿状态…':'读取草稿状态'} secondary disabled={busy||reading} onPress={()=>{setError('');setRefresh(n=>n+1);}}/>}
  {data&&<>
   {data.goal.status==='draft'&&<Card><AppText>选择依据</AppText><Caption>最多选择3次当前版本搜索。服务端选取最多3份有正文或摘要的资料；仅片段不会作为草稿依据。</Caption>
    {!eligible.length&&<Caption>暂无有正文或摘要的资料，请先搜索。</Caption>}
    {eligible.map(a=><Action key={a.id} label={`${selected.includes(a.id)?'取消选择':'选择资料'}：${a.query}`} secondary disabled={busy||reading||hasOperation||(!selected.includes(a.id)&&selected.length===3)} onPress={()=>setSelected(old=>old.includes(a.id)?old.filter(id=>id!==a.id):[...old,a.id])}/>)}
    <Action label={busy?'正在生成草稿…':ended?'本次生成已结束':hasOperation?'恢复本次生成请求':`生成计划草稿（已选 ${selected.length} / 3）`} disabled={busy||reading||ended||(!hasOperation&&(!selected.length||active))} onPress={()=>{void generate();}}/>
    <Caption>每账号每日最多3次生成尝试，失败或结果不明也占额度。恢复同一请求不另建尝试。</Caption>
    {ended&&<Caption>本次请求已结束；恢复不会改变结果。如需再次生成，请明确另开请求。</Caption>}
   {hasOperation&&<Action label="另生成一份草稿" secondary disabled={busy||reading||active} onPress={()=>setConfirm(true)}/>}
    {confirm&&<><Caption>新的生成请求可能再次计费，已有草稿保留。</Caption><Action label="确认另开生成请求" disabled={busy||active} onPress={()=>{operation.current=null;setHasOperation(false);setEnded(false);setConfirm(false);setSelected([]);setError('');}}/><Action label="保留当前请求" secondary onPress={()=>setConfirm(false)}/></>}
   </Card>}
   {!data.attempts.length&&<Caption>尚无草稿，请主动选择资料并生成。</Caption>}
   {data.attempts.map(a=><Card key={a.id}>
    <Badge>{a.status==='succeeded'?'草稿已生成 · 待审阅':a.status==='submitted'?'生成已提交 · 待读取状态':a.status==='unknown'?'生成结果不明':'本次生成失败'}</Badge>
    {a.goal_revision!==data.goal.revision&&<Caption>对应旧目标版本，仅供查看，请重新核对适用性。</Caption>}
    {!!a.error_code&&<Caption>{planError(a.error_code)}</Caption>}
    {a.draft&&<>
     <AppText accessibilityRole="header">{a.draft.title}</AppText><AppText>{a.draft.summary}</AppText><Caption>预计每周投入 {a.draft.weekly_minutes} 分钟；尚未验证是否符合你的时间。成本未知，尚未排程。</Caption>
     <Card><AppText>本次条件快照</AppText><Caption>{a.context.goal.description}</Caption>{a.context.conditions.map(s=><Caption key={s.key}>{s.key==='outcome'?'目标成果':s.key==='available_time'?'可用时间':'限制'}：{s.value.state==='confirmed'?s.value.text:'尚未确认'}</Caption>)}</Card>
     <Card><AppText>待核对假设与风险</AppText>{[...a.draft.assumptions,...a.draft.risks].map((s,i)=><Caption key={i}>{s}</Caption>)}<Caption>引用存在不代表专业效果或事实已核实。</Caption></Card>
     {a.draft.tasks.map(t=><Card key={t.id}><Badge>阶段 {t.stage} · {t.mandatory?'必要任务':'可选任务'}</Badge><AppText>{t.title}</AppText><AppText>{t.instructions}</AppText><Caption>每次 {t.duration_minutes} 分钟 · 每周 {t.frequency_per_week} 次</Caption>{!!t.depends_on.length&&<Caption>先完成：{t.depends_on.map(id=>a.draft!.tasks.find(task=>task.id===id)!.title).join('、')}</Caption>}{!t.evidence_ids.length&&<Caption>此任务没有单独的外部引用，请核对做法。</Caption>}{t.evidence_ids.map(id=>{const s=a.context.sources.find(s=>s.source_id===id)!;return <Card key={id}><AppText>依据：{s.title}</AppText><Caption>搜索时间：{new Date(s.searched_at).toLocaleString()} · 内容未核实</Caption><Caption>{s.url}</Caption><AppText>{s.content}</AppText><Action label={`打开引用：${s.title}`} secondary onPress={()=>{void Linking.openURL(s.url).catch(()=>setError('无法打开引用网页。'));}}/></Card>;})}</Card>)}
     <Caption>本轮只提供草稿审阅；确认计划、编辑任务及入历功能尚未开放。</Caption>
    </>}
   </Card>)}
  </>}
 </Screen>;
}
