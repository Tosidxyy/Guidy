import { useCallback, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { KeyboardAvoidingView, Linking, Platform, TextInput } from 'react-native';
import { Action, AppText, Badge, Caption, Card, Screen } from '../../../src/components/ui';
import { useAccount } from '../../../src/auth/AuthProvider';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { addSource, getResearch, getResearchJobs, submitResearchJob, type Research, type ResearchJobs } from '../../../src/goals/api';
import { sourceError, jobError } from '../../../src/goals/research';
export default function ResearchPage(){const {id}=useLocalSearchParams<{id:string}>();const {user}=useAccount();return <ResearchBody key={`${user?.id??''}:${id}`} id={id} owner={user?.id}/>;}
function ResearchBody({id,owner}:{id:string;owner?:string}){
  const {colors}=useTheme();const [data,setData]=useState<Research|null>(null);const [url,setUrl]=useState('');const [claim,setClaim]=useState('');const [caveat,setCaveat]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [refresh,setRefresh]=useState(0);const [discard,setDiscard]=useState(false);
  const scope=useRef(0);const lock=useRef(false);const operation=useRef<{payload:string;key:string}|null>(null);
  const [jobs,setJobs]=useState<ResearchJobs|null>(null);const [selected,setSelected]=useState<string[]>([]);const jobOperation=useRef<{payload:string;key:string}|null>(null);const polling=useRef(false);const jobReadBusy=useRef<number|null>(null);
  const readJobs=useCallback(async(signal:AbortSignal,generation:number)=>{
    if(jobReadBusy.current===generation)return;jobReadBusy.current=generation;
    try{const result=await getResearchJobs(id,signal);if(signal.aborted||generation!==scope.current)return;setJobs(result);polling.current=result.jobs.some(j=>j.dispatched===1&&['queued','running'].includes(j.status));}
    catch(err){if(!signal.aborted&&generation===scope.current)setError(err instanceof Error?err.message:'读取任务失败。');}
    finally{if(jobReadBusy.current===generation)jobReadBusy.current=null;}
  },[id]);
  useFocusEffect(useCallback(()=>{void refresh;const generation=++scope.current;const controller=new AbortController();setData(null);setJobs(null);polling.current=false;if(owner){void readJobs(controller.signal,generation);getResearch(id,controller.signal).then(value=>{if(!controller.signal.aborted&&generation===scope.current)setData(value);}).catch(err=>{if(!controller.signal.aborted)setError(err instanceof Error?err.message:'读取失败。');});}const timer=setInterval(()=>{if(polling.current)void readJobs(controller.signal,generation);},3000);return()=>{controller.abort();clearInterval(timer);scope.current++;};},[id,owner,refresh,readJobs]));
  async function start(resumeId?:string){
    if(!data||lock.current)return;
    const body=resumeId?{resume_job_id:resumeId}:{evidence_ids:selected,expected_revision:data.goal.revision};const payload=JSON.stringify(body);if(jobOperation.current?.payload!==payload)jobOperation.current={payload,key:`job_${Date.now()}_${Math.random().toString(36).slice(2,12)}`};
    const generation=scope.current;lock.current=true;setBusy(true);setError('');
    try{const result=await submitResearchJob(id,body,jobOperation.current.key);if(generation!==scope.current)return;setJobs(result);polling.current=result.jobs.some(j=>j.dispatched===1&&['queued','running'].includes(j.status));jobOperation.current=null;setSelected([]);}
    catch(err){if(generation!==scope.current)return;setError(err instanceof Error?err.message:'任务未启动。');await readJobs(new AbortController().signal,generation);}
    finally{lock.current=false;setBusy(false);}
  }
  const active=data?.evidence.some(e=>e.status==='fetching');
  async function submit(){
    if(!data||lock.current||active||data.goal.status!=='draft')return;
    const body={url:url.trim(),claim:claim.trim(),caveat:caveat.trim(),expected_revision:data.goal.revision};if(!body.url||!body.claim){setError('请填写网页链接和想核对的问题。');return;}
    const payload=JSON.stringify(body);if(operation.current?.payload!==payload)operation.current={payload,key:`source_${Date.now()}_${Math.random().toString(36).slice(2,12)}`};const generation=scope.current;lock.current=true;setBusy(true);setError('');
    try{const value=await addSource(id,body,operation.current.key);if(generation!==scope.current)return;setData(value);if(!value.evidence.some(e=>e.status==='fetching')){setUrl('');setClaim('');setCaveat('');operation.current=null;}}
    catch(err){if(generation!==scope.current)return;setError(err instanceof Error?err.message:'读取失败，输入保留。');try{const value=await getResearch(id,new AbortController().signal);if(generation===scope.current)setData(value);}catch{/* Keep inputs for explicit retry. */}}
    finally{lock.current=false;setBusy(false);}
  }
  const input={backgroundColor:colors.surface,color:colors.text,borderWidth:1,borderColor:colors.divider,borderRadius:15,padding:12,minHeight:52,fontSize:17};
  const leave=()=>router.replace({pathname:'/goal/[id]',params:{id}});
  const form=data?.goal.status==='draft'?<>
    <TextInput accessibilityLabel="来源网页链接" value={url} onChangeText={setUrl} editable={!busy&&!active} maxLength={2000} autoCapitalize="none" autoCorrect={false} placeholder="https://…" placeholderTextColor={colors.secondary} style={input}/>
    <TextInput accessibilityLabel="想核对的问题" value={claim} onChangeText={setClaim} editable={!busy&&!active} maxLength={300} placeholder="这份资料能帮助回答什么问题？" placeholderTextColor={colors.secondary} style={input}/>
    <TextInput accessibilityLabel="适用条件或限制" value={caveat} onChangeText={setCaveat} editable={!busy&&!active} maxLength={300} placeholder="适用条件或限制（可不填）" placeholderTextColor={colors.secondary} style={input}/>
    <Action label={busy?'正在读取网页…':'添加并读取来源'} disabled={busy||active||!url.trim()||!claim.trim()} onPress={submit}/>
  </>:undefined;
  return <KeyboardAvoidingView style={{flex:1,backgroundColor:colors.background}} behavior={Platform.OS==='ios'?'padding':undefined}><Screen title="研究资料与来源" bottomInset footer={form}>
    <Action label="返回目标详情" secondary disabled={busy} onPress={()=>url||claim||caveat?setDiscard(true):leave()}/>
    {discard&&<Card><AppText>放弃尚未提交的来源输入？已提交的记录保留。</AppText><Action label="放弃并返回" onPress={leave}/><Action label="继续填写" secondary onPress={()=>setDiscard(false)}/></Card>}
    <Badge>来源准备 · 尚未形成研究结论</Badge><Caption>添加官网网页和想核对的问题。可选最多3份资料交给后台重新读取与归档；成功启动后，离开 App 不会取消。当前没有自动搜索或事实核验。</Caption>
    {!!error&&<AppText accessibilityRole="alert">{error}</AppText>}
    {!owner&&<Caption>请登录后查看资料。</Caption>}
    {owner&&<Action label="重新读取资料状态" secondary disabled={busy} onPress={()=>{setError('');setRefresh(n=>n+1);}}/>}
    {data&&<>
      {jobs&&<Card>
        <AppText>后台资料任务</AppText><Caption>仅重新读取选定来源，结果仍未核实。每账号每日最多3次新任务；旧任务启动失败时可继续尝试同一任务。</Caption>
        <Action label={`启动后台资料任务（已选 ${selected.length} / 3）`} disabled={busy||!selected.length||data.goal.status!=='draft'||jobs.jobs.some(j=>['queued','running'].includes(j.status))} onPress={()=>start()}/>
        {jobs.jobs.map(j=><Card key={j.id}>
          <Badge>{j.status==='queued'?(j.dispatched?'后台排队中':'已保存 · 尚未启动'):j.status==='running'?'后台读取中':j.status==='completed'?'来源处理结束 · 内容未核实':'任务未完成'}</Badge>
          <Caption>{j.items.filter(i=>['available','failed'].includes(i.status)).length} / {j.items.length} 项已处理 · {j.items.filter(i=>i.status==='failed').length} 项读取失败</Caption>
          {!!j.error_code&&<Caption>{jobError(j.error_code)}</Caption>}
          {j.status==='queued'&&!j.dispatched&&<Action label="尝试启动已保存任务" secondary disabled={busy} onPress={()=>start(j.id)}/>}
          {j.goal_revision!==data.goal.revision&&<Caption>对应旧目标版本，请重新核对适用性。</Caption>}
          {j.items.map(item=><Card key={item.position}><AppText>{item.claim}</AppText><Caption>{item.status==='available'?'已读取 · 未核实':item.status==='failed'?'读取失败':item.status==='reading'?'读取中':'等待处理'}</Caption><Caption>{item.source_url}</Caption>{!!item.retrieved_at&&<Caption>访问时间：{new Date(item.retrieved_at).toLocaleString()}</Caption>}{!!item.excerpt&&<AppText>{item.excerpt}</AppText>}{!!item.error_code&&<Caption>{sourceError(item.error_code)}</Caption>}</Card>)}
        </Card>)}
      </Card>}
      <Card><AppText>{data.goal.description||data.goal.title}</AppText><Caption>支持 learnenglish.britishcouncil.org、www.nhs.uk、www.who.int、www.aad.org 的 HTTPS HTML 页面。暂不支持跳转、查询参数或 PDF。</Caption></Card>
      {!data.evidence.length&&<Caption>尚无资料。添加来源不会确认事实或生成计划。</Caption>}
      {data.evidence.map(e=><Card key={e.id}>
        {data.goal.status==='draft'&&e.goal_revision===data.goal.revision&&e.status!=='fetching'&&<Action label={`${selected.includes(e.id)?'取消选择':'选择为后台来源'}：${e.claim}`} secondary disabled={busy||(!selected.includes(e.id)&&selected.length===3)} onPress={()=>setSelected(old=>old.includes(e.id)?old.filter(id=>id!==e.id):[...old,e.id])}/>}
        <Badge>{e.status==='available'?'已读取 · 内容未核实':e.status==='fetching'?'读取中 · 待查状态':'读取失败 · 未核实'}</Badge>
        <AppText>{e.title||e.claim}</AppText><Caption>待核对问题：{e.claim}</Caption><Caption>{e.source_url}</Caption>
        {!!e.retrieved_at&&<Caption>访问时间：{new Date(e.retrieved_at).toLocaleString()}</Caption>}
        {!!e.caveat&&<Caption>你填写的适用限制：{e.caveat}</Caption>}
        {e.goal_revision!==data.goal.revision&&<Caption>对应旧目标版本，适用性需要重新核对。</Caption>}
        {!!e.excerpt&&<AppText>{e.excerpt}</AppText>}
        {e.status==='failed'&&<><Caption>{sourceError(e.error_code??'')}</Caption><Action label="填回这条来源重新尝试" secondary disabled={busy||active||data.goal.status!=='draft'} onPress={()=>{setUrl(e.source_url);setClaim(e.claim);setCaveat(e.caveat);operation.current=null;}}/></>}
        <Action label="打开原始网页" secondary onPress={()=>{void Linking.openURL(e.source_url).catch(()=>setError('无法打开网页，请稍后再试。'));}}/>
      </Card>)}
    </>}
  </Screen></KeyboardAvoidingView>;
}
