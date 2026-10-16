import {useCallback,useRef,useState} from 'react';
import {router,useFocusEffect,useLocalSearchParams} from 'expo-router';
import {Action,AppText,Badge,Caption,Card,Screen,styles} from '../../src/components/ui';
import {useAccount} from '../../src/auth/AuthProvider';
import {getGoal,GoalApiError,setGoalStatus,type AccountGoal} from '../../src/goals/api';

export default function GoalDetail(){
 const {id}=useLocalSearchParams<{id:string}>(),{user,pending}=useAccount();
 return <GoalSummary key={String(user?.id)+':'+id} id={id} owner={user?.id} pending={pending}/>;
}
function GoalSummary({id,owner,pending}:{id:string;owner?:string;pending:boolean}){
 const [goal,setGoal]=useState<AccountGoal|null>(null),[loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false),[refresh,setRefresh]=useState(0);
 const generation=useRef(0),busy=useRef(false),operation=useRef<{payload:string;key:string}|null>(null);
 useFocusEffect(useCallback(()=>{void refresh;const current=++generation.current,c=new AbortController();setGoal(null);setError('');setConflict(false);setSaving(false);setLoading(!!owner);if(owner)void getGoal(id,c.signal).then(value=>{if(!c.signal.aborted){setGoal(value);operation.current=null;}}).catch(e=>{if(!c.signal.aborted)setError(e instanceof Error?e.message:'读取目标失败。');}).finally(()=>{if(current===generation.current&&!c.signal.aborted)setLoading(false);});return()=>{c.abort();generation.current++;};},[id,owner,refresh]));
 async function changeStatus(){
  if(!goal||!owner||busy.current||loading||conflict||!['draft','paused'].includes(goal.status))return;
  const body={status:goal.status==='paused'?'draft' as const:'paused' as const,expected_revision:goal.revision},payload=JSON.stringify(body);
  if(operation.current?.payload!==payload)operation.current={payload,key:'status_'+Date.now()+'_'+Math.random().toString(36).slice(2,12)};
  const current=generation.current;busy.current=true;setSaving(true);setError('');
  try{const result=await setGoalStatus(id,body,operation.current.key);if(current!==generation.current)return;setGoal(result);operation.current=null;if(result.status==='draft')router.push({pathname:'/goal/[id]/chat',params:{id}});}
  catch(e){if(current===generation.current){setError(e instanceof Error?e.message:'状态尚未确认，请读取后再试。');if(e instanceof GoalApiError)setConflict(true);}}
  finally{busy.current=false;if(current===generation.current)setSaving(false);}
 }
 return <Screen title="目标" bottomInset>
  <Action label="返回目标" secondary disabled={saving} onPress={()=>router.replace('/(tabs)/goals')}/>
  {!owner&&<Caption>{pending?'正在恢复账号…':'登录后查看你的目标。'}</Caption>}
  {loading&&<Caption>正在读取目标…</Caption>}
  {!!error&&<AppText accessibilityRole="alert">{error}</AppText>}
  {owner&&!loading&&(conflict||!goal)&&<Action label="重新读取目标" secondary disabled={saving} onPress={()=>setRefresh(n=>n+1)}/>}
  {goal&&<>
   <Badge>{goal.status==='paused'?'已暂停':goal.status==='active'?'进行中':goal.status==='draft'?'待制订':'已保存'}</Badge>
   <Card><AppText style={styles.heading}>{goal.description||goal.title}</AppText><Caption>补充想法或调整方案，都可以直接告诉 Guidy。</Caption></Card>
   {['draft','active'].includes(goal.status)&&<Action label={goal.status==='active'?'查看方案与日程':'Guidy！'} disabled={saving||loading||conflict} onPress={()=>router.push({pathname:'/goal/[id]/chat',params:{id}})}/>}
   {['draft','paused'].includes(goal.status)&&<><Action label={saving?'正在处理…':goal.status==='paused'?'继续问答':'稍后再聊'} secondary={goal.status==='draft'} disabled={saving||loading||conflict} onPress={()=>{void changeStatus();}}/><Caption>尚未确认的目标可以暂停问答，原有回答会保留。</Caption></>}
  </>}
 </Screen>;
}
