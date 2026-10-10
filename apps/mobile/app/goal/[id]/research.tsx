import { useCallback, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { KeyboardAvoidingView, Linking, Platform, TextInput } from 'react-native';
import { Action, AppText, Badge, Caption, Card, Screen } from '../../../src/components/ui';
import { useAccount } from '../../../src/auth/AuthProvider';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { addSource, getResearch, type Research } from '../../../src/goals/api';
import { sourceError } from '../../../src/goals/research';
export default function ResearchPage(){const {id}=useLocalSearchParams<{id:string}>();const {user}=useAccount();return <ResearchBody key={`${user?.id??''}:${id}`} id={id} owner={user?.id}/>;}
function ResearchBody({id,owner}:{id:string;owner?:string}){
  const {colors}=useTheme();const [data,setData]=useState<Research|null>(null);const [url,setUrl]=useState('');const [claim,setClaim]=useState('');const [caveat,setCaveat]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [refresh,setRefresh]=useState(0);const [discard,setDiscard]=useState(false);
  const scope=useRef(0);const lock=useRef(false);const operation=useRef<{payload:string;key:string}|null>(null);
  useFocusEffect(useCallback(()=>{void refresh;const generation=++scope.current;const controller=new AbortController();setData(null);if(owner)getResearch(id,controller.signal).then(value=>{if(!controller.signal.aborted&&generation===scope.current)setData(value);}).catch(err=>{if(!controller.signal.aborted)setError(err instanceof Error?err.message:'读取失败。');});return()=>{controller.abort();scope.current++;};},[id,owner,refresh]));
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
    <Badge>来源准备 · 尚未形成研究结论</Badge><Caption>添加官网网页和想核对的问题。只读取短摘录，内容尚未核实；当前没有自动搜索或后台研究。</Caption>
    {!!error&&<AppText accessibilityRole="alert">{error}</AppText>}
    {!owner&&<Caption>请登录后查看资料。</Caption>}
    {owner&&<Action label="重新读取资料状态" secondary disabled={busy} onPress={()=>{setError('');setRefresh(n=>n+1);}}/>}
    {data&&<>
      <Card><AppText>{data.goal.description||data.goal.title}</AppText><Caption>支持 learnenglish.britishcouncil.org、www.nhs.uk、www.who.int、www.aad.org 的 HTTPS HTML 页面。暂不支持跳转、查询参数或 PDF。</Caption></Card>
      {!data.evidence.length&&<Caption>尚无资料。添加来源不会确认事实或生成计划。</Caption>}
      {data.evidence.map(e=><Card key={e.id}>
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
