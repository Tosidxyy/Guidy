import {useCallback,useRef,useState} from 'react';
import {router,useFocusEffect,useLocalSearchParams} from 'expo-router';
import {Keyboard,KeyboardAvoidingView,Platform,TextInput} from 'react-native';
import {Action,AppText,Badge,Caption,Card,Screen} from '../../../src/components/ui';
import {useAccount} from '../../../src/auth/AuthProvider';
import {useTheme} from '../../../src/theme/ThemeProvider';
import {getReviews,saveReview} from '../../../src/goals/api';
import {reviewNumber,type ReviewSnapshot,type PlanDraft} from '../../../src/goals/plans';
type Fields=Record<string,{minutes:string;frequency:string}>;
const fieldsFor=(draft:PlanDraft)=>Object.fromEntries(draft.tasks.map(t=>[t.id,{minutes:String(t.duration_minutes),frequency:String(t.frequency_per_week)}]));
function keyFor(){return `review_${Date.now()}_${Math.random().toString(36).slice(2,12)}`;}
export default function ReviewPage(){const {id,attemptId}=useLocalSearchParams<{id:string;attemptId:string}>();const {user}=useAccount();return <ReviewBody key={`${user?.id??''}:${id}:${attemptId}`} id={id} attemptId={attemptId} owner={user?.id}/>;}
function ReviewBody({id,attemptId,owner}:{id:string;attemptId:string;owner?:string}){
 const {colors}=useTheme();const [data,setData]=useState<ReviewSnapshot|null>(null),[fields,setFields]=useState<Fields>({}),[base,setBase]=useState<number|null>(null),[busy,setBusy]=useState(false),[reading,setReading]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[discard,setDiscard]=useState(false),[reset,setReset]=useState(false);
 const scope=useRef(0),lock=useRef(false),initialized=useRef(false),operation=useRef<{payload:string;key:string}|null>(null);
 const load=useCallback(async(signal:AbortSignal,generation:number)=>{setReading(true);try{const value=await getReviews(id,attemptId,signal);if(signal.aborted||generation!==scope.current)return;setData(value);if(!initialized.current){setFields(fieldsFor(value.reviews[0]?.draft??value.source.draft!));setBase(value.current_revision);initialized.current=true;}}catch(err){if(!signal.aborted&&generation===scope.current)setError(err instanceof Error?err.message:'读取失败。');}finally{if(generation===scope.current)setReading(false);}},[id,attemptId]);
 useFocusEffect(useCallback(()=>{const generation=++scope.current,controller=new AbortController();if(owner)void load(controller.signal,generation);return()=>{controller.abort();scope.current++;};},[owner,load]));
 const draft=data?.reviews.find(r=>r.revision===base)?.draft??data?.source.draft;
 const changes=draft?.tasks.map(t=>({task_id:t.id,duration_minutes:reviewNumber(fields[t.id]?.minutes??'',5,120),frequency_per_week:reviewNumber(fields[t.id]?.frequency??'',1,7)}));
 const valid=changes?.every(c=>c.duration_minutes!==null&&c.frequency_per_week!==null)??false;
 const total=valid?changes!.reduce((sum,c)=>sum+c.duration_minutes!*c.frequency_per_week!,0):null;
 const dirty=draft?.tasks.some(t=>fields[t.id]?.minutes!==String(t.duration_minutes)||fields[t.id]?.frequency!==String(t.frequency_per_week))??false;
 const changed=valid&&draft?.tasks.some((t,i)=>changes![i].duration_minutes!==t.duration_minutes||changes![i].frequency_per_week!==t.frequency_per_week);
 const stale=data&&base!==data.current_revision;
 function replaceInputs(){if(!data)return;setFields(fieldsFor(data.reviews[0]?.draft??data.source.draft!));setBase(data.current_revision);operation.current=null;setReset(false);setError('');setMessage('已加载最新版本，请重新核对。');}
 async function save(){if(!data||base===null||!valid||!changed||!data.can_edit||stale||lock.current||reading)return;const body={expected_goal_revision:data.goal.revision,expected_review_revision:base,changes:changes!.map(c=>({...c,duration_minutes:c.duration_minutes!,frequency_per_week:c.frequency_per_week!}))};const payload=JSON.stringify(body);if(operation.current?.payload!==payload)operation.current={payload,key:keyFor()};const generation=scope.current;lock.current=true;setBusy(true);setError('');setMessage('');try{const value=await saveReview(id,attemptId,body,operation.current.key);if(generation!==scope.current)return;setData(value);setBase(value.current_revision);setFields(fieldsFor(value.reviews[0].draft));operation.current=null;setMessage(`已保存审阅版本 ${value.receipt_revision}。仍未确认或排程。`);Keyboard.dismiss();}catch(err){if(generation!==scope.current)return;setError(err instanceof Error?err.message:'保存状态不明，输入保留。');await load(new AbortController().signal,generation);}finally{lock.current=false;setBusy(false);}}
 const leave=()=>router.replace({pathname:'/goal/[id]/plan',params:{id}});
 const input={backgroundColor:colors.surface,color:colors.text,borderColor:colors.divider,borderWidth:1,borderRadius:15,padding:12,minHeight:52,fontSize:17};
 return <KeyboardAvoidingView style={{flex:1,backgroundColor:colors.background}} behavior={Platform.OS==='ios'?'padding':undefined}><Screen title="调整时长与频次" bottomInset footer={data&&draft?<><Caption>{total===null?'请填写有效整数。':`调整后预计每周 ${total} 分钟，适配性尚未校验。`}</Caption><Action label={busy?'正在保存…':'保存独立审阅版本'} disabled={busy||reading||!valid||!changed||!data.can_edit||!!stale} onPress={()=>{void save();}}/></>:undefined}>
  <Action label="返回草稿" secondary disabled={busy} onPress={()=>dirty?setDiscard(true):leave()}/>
  {discard&&<Card><AppText>放弃本页尚未保存的输入？已保存版本保留。</AppText><Action label="放弃并返回" onPress={leave}/><Action label="继续调整" secondary onPress={()=>setDiscard(false)}/></Card>}
  <Badge>用户调整 · 仍待审阅</Badge><Caption>仅调整每次分钟与每周次数，不调用模型。AI原稿、任务编号、依赖和引用保留；新时长可能与步骤文字不同，请核对。保存不代表计划可执行或写入日历。</Caption>
  {!!error&&<AppText accessibilityRole="alert">{error}</AppText>}{!!message&&<AppText accessibilityRole="alert">{message}</AppText>}
  {!owner&&<Caption>请登录后调整。</Caption>}
  {owner&&<Action label={reading?'正在读取版本…':'读取审阅版本（保留输入）'} secondary disabled={busy||reading} onPress={()=>{setError('');void load(new AbortController().signal,scope.current);}}/>}
  {data&&draft&&<>
   <AppText>{draft.title}</AppText><Caption>当前输入基于{base===0?'AI原稿':`审阅版本 ${base}`}；最新已保存版本 {data.current_revision}。每份草稿最多20个审阅版本。</Caption>
   {!data.can_edit&&<Caption>{data.current_revision===20?'已达到20个审阅版本上限，已有版本可查看。':'目标条件、安全状态或目标版本已改变，目前仅可查看。输入仍保留。'}</Caption>}
   {stale&&<Caption>另一份审阅版本已保存。你的输入保留，请先核对最新版本，不能直接覆盖。</Caption>}
   <Action label="加载最新已保存版本" secondary disabled={busy||reading} onPress={()=>dirty?setReset(true):replaceInputs()}/>
   {reset&&<Card><AppText>使用最新版本替换本页未保存输入？</AppText><Action label="确认加载最新版本" onPress={replaceInputs}/><Action label="保留我的输入" secondary onPress={()=>setReset(false)}/></Card>}
   {draft.tasks.map(t=><Card key={t.id}><AppText>{t.title}</AppText><Caption>{t.instructions}</Caption><Caption>每次5–120分钟，每周1–7次；不自动判断健康适用性。</Caption><TextInput accessibilityLabel={`每次分钟：${t.title}`} value={fields[t.id]?.minutes??''} keyboardType="number-pad" maxLength={3} editable={!busy&&!reading&&data.can_edit} style={input} onChangeText={value=>{setFields(old=>({...old,[t.id]:{...old[t.id],minutes:value}}));setMessage('');}}/><TextInput accessibilityLabel={`每周次数：${t.title}`} value={fields[t.id]?.frequency??''} keyboardType="number-pad" maxLength={3} editable={!busy&&!reading&&data.can_edit} style={input} onChangeText={value=>{setFields(old=>({...old,[t.id]:{...old[t.id],frequency:value}}));setMessage('');}}/></Card>)}
   <Card><AppText>保存历史</AppText><Caption>AI原稿保留在本目标下，已有版本不会覆盖；删除目标仍按账号数据删除规则执行。</Caption>{data.reviews.map(r=><Caption key={r.id}>审阅版本 {r.revision} · 每周 {r.draft.weekly_minutes} 分钟 · {new Date(r.created_at).toLocaleString()}</Caption>)}</Card>
  </>}
 </Screen></KeyboardAvoidingView>;
}
