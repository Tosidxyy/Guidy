import { useCallback, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Keyboard, KeyboardAvoidingView, Linking, Platform, TextInput } from 'react-native';
import { Action, AppText, Badge, Caption, Card, Screen } from '../../../src/components/ui';
import { useAccount } from '../../../src/auth/AuthProvider';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { getSearch, submitSearch } from '../../../src/goals/api';
import { validSearchQuery, searchError, type SearchSnapshot } from '../../../src/goals/search';

export default function SearchPage(){const {id}=useLocalSearchParams<{id:string}>();const {user}=useAccount();return <SearchBody key={`${user?.id??''}:${id}`} id={id} owner={user?.id}/>;}
function SearchBody({id,owner}:{id:string;owner?:string}){
  const {colors}=useTheme();const [data,setData]=useState<SearchSnapshot|null>(null);const [query,setQuery]=useState('');const [open,setOpen]=useState(false);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [reading,setReading]=useState(false);const [revision,setRevision]=useState(0);const [newConfirm,setNewConfirm]=useState(false);const [hasOperation,setHasOperation]=useState(false);
  const scope=useRef(0),lock=useRef(false);const operation=useRef<{query:string;expected_revision:number;key:string;knownIds:string[];attemptId?:string}|null>(null);
  const read=useCallback(async(signal:AbortSignal,generation:number)=>{
    setReading(true);
    try{const value=await getSearch(id,signal);if(signal.aborted||generation!==scope.current)return;setData(value);}
    catch(err){if(!signal.aborted&&generation===scope.current)setError(err instanceof Error?err.message:'状态读取失败。');}
    finally{if(generation===scope.current)setReading(false);}
  },[id]);
  useFocusEffect(useCallback(()=>{void revision;const generation=++scope.current;const controller=new AbortController();setData(null);if(owner)void read(controller.signal,generation);return()=>{controller.abort();scope.current++;};},[owner,revision,read]));
  const pending=data?.attempts.some(a=>a.status==='submitted');
  async function submit(){
    if(!data||lock.current||reading||data.goal.status!=='draft'||(pending&&!operation.current))return;
    if(!operation.current){if(!validSearchQuery(query)){setError(searchError('SEARCH_QUERY_REJECTED'));return;}operation.current={query:query.trim(),expected_revision:data.goal.revision,key:`search_${Date.now()}_${Math.random().toString(36).slice(2,12)}`,knownIds:data.attempts.map(a=>a.id)};}
    setHasOperation(true);const op=operation.current,generation=scope.current;lock.current=true;setBusy(true);setError('');
    try{const value=await submitSearch(id,{query:op.query,expected_revision:op.expected_revision},op.key);if(generation!==scope.current)return;setData(value);const result=value.attempts.find(a=>op.attemptId?a.id===op.attemptId:a.query===op.query&&a.goal_revision===op.expected_revision&&!op.knownIds.includes(a.id));if(result)op.attemptId=result.id;if(result?.status==='succeeded'){setOpen(false);Keyboard.dismiss();}else if(result?.error_code)setError(searchError(result.error_code));}
    catch(err){if(generation!==scope.current)return;setError(err instanceof Error?err.message:'搜索状态不明，请读取状态。');await read(new AbortController().signal,generation);}
    finally{lock.current=false;setBusy(false);}
  }
  const footer=open&&data?.goal.status==='draft'?<>
    <Action label="收起搜索输入（保留内容）" secondary disabled={busy} onPress={()=>{Keyboard.dismiss();setOpen(false);}}/>
    <TextInput accessibilityLabel="搜索问题" value={query} onChangeText={setQuery} editable={!busy&&!hasOperation} maxLength={200} multiline placeholder="例如：英语初学者学习方法 官方资料" placeholderTextColor={colors.secondary} style={{backgroundColor:colors.surface,color:colors.text,borderColor:colors.divider,borderWidth:1,borderRadius:15,padding:12,height:80,fontSize:17,textAlignVertical:'top'}}/>
    <Action label={busy?'正在搜索…':hasOperation?'恢复同一搜索请求':'搜索资料'} disabled={busy||reading||(!hasOperation&&(!validSearchQuery(query)||pending))} onPress={submit}/>
  </>:undefined;
  return <KeyboardAvoidingView style={{flex:1,backgroundColor:colors.background}} behavior={Platform.OS==='ios'?'padding':undefined}><Screen title="搜索研究资料" bottomInset footer={footer}>
    <Action label="返回研究资料" secondary disabled={busy} onPress={()=>router.replace({pathname:'/goal/[id]/research',params:{id}})}/>
    <Badge>豆包搜索 · 内容未核实</Badge><Caption>搜索问题会发送给搜索服务。请使用通用问题，不填写姓名、邮箱、电话或私人病史。搜索不会生成计划或写入日历。</Caption>
    {!!error&&<AppText accessibilityRole="alert">{error}</AppText>}
    {!owner&&<Caption>请登录后搜索。</Caption>}
    {owner&&<Action label={reading?'正在读取搜索状态…':'读取搜索状态'} secondary disabled={busy||reading} onPress={()=>{setError('');setRevision(n=>n+1);}}/>}
    {data&&<>
      <Caption>每目标版本最多3次，账号每日6次；失败与结果不明也占额度。每次最多5个来源，实际计费以服务账单为准。</Caption>
      {pending&&<Caption>有请求尚未结束，请稍后读取状态；不会自动再次搜索。</Caption>}
      {data.goal.status!=='draft'&&<Caption>当前目标仅可查看历史搜索。</Caption>}
      {data.goal.status==='draft'&&!open&&<Action label={hasOperation||query?'查看搜索输入':'填写搜索问题'} disabled={busy||reading} onPress={()=>setOpen(true)}/>}
      {data.goal.status==='draft'&&hasOperation&&<Action label="开始另一次搜索" secondary disabled={busy||reading||pending} onPress={()=>setNewConfirm(true)}/>}
      {newConfirm&&<Card><AppText>新搜索可能再次消耗额度。尚未确认的旧搜索不会取消。</AppText><Action label="确认另开一次搜索" disabled={busy||pending} onPress={()=>{operation.current=null;setHasOperation(false);setNewConfirm(false);setOpen(true);setError('');}}/><Action label="保留当前请求" secondary onPress={()=>setNewConfirm(false)}/></Card>}
      {!data.attempts.length&&<Caption>尚无搜索记录。先确认目标成果与可用时间，再主动搜索。</Caption>}
      {data.attempts.map(a=><Card key={a.id}>
        <AppText>{a.query}</AppText><Badge>{a.status==='succeeded'?'搜索完成 · 内容未核实':a.status==='submitted'?'搜索已提交 · 待读取状态':a.status==='unknown'?'搜索结果不明':'搜索失败'}</Badge>
        {a.goal_revision!==data.goal.revision&&<Caption>对应旧目标版本，请重新核对适用性。</Caption>}
        {!!a.error_code&&<Caption>{searchError(a.error_code)}</Caption>}
        {a.result&&<>
          <Caption>搜索时间：{new Date(a.result.searched_at).toLocaleString()}</Caption>
          {!a.result.sources.length&&<Caption>没有返回可展示来源，不代表已找到充分依据。</Caption>}
          {a.result.sources.map(s=><Card key={s.source_id}><AppText>{s.title}</AppText><Badge>{s.content_kind==='provider_content'?'供应商正文摘录':s.content_kind==='provider_summary'?'供应商相关摘要':'仅搜索片段 · 正文不足'}</Badge><Caption>{s.url}</Caption>{s.published_at&&<Caption>来源标注发布时间：{s.published_at}</Caption>}<AppText>{s.content||s.snippet||'没有可用正文。'}</AppText><Action label={`打开来源：${s.title}`} secondary onPress={()=>{void Linking.openURL(s.url).catch(()=>setError('无法打开来源网页。'));}}/></Card>)}
        </>}
      </Card>)}
    </>}
  </Screen></KeyboardAvoidingView>;
}
