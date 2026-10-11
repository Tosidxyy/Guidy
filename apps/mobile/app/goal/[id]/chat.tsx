import { useCallback, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { Action, AppText, Badge, Caption, Card, Screen } from '../../../src/components/ui';
import { useAccount } from '../../../src/auth/AuthProvider';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { getDialogue, sendDialogue } from '../../../src/goals/api';
import { dialogueError, type Dialogue } from '../../../src/goals/dialogue';

export default function GoalChat(){
  const {id}=useLocalSearchParams<{id:string}>();const {user}=useAccount();
  return <GoalChatBody key={`${user?.id??'anonymous'}:${id}`} id={id} owner={user?.id}/>;
}
function GoalChatBody({id,owner}:{id:string;owner:string|undefined}){
  const {colors}=useTheme();
  const [record,setRecord]=useState<{owner:string;data:Dialogue}|null>(null);const [text,setText]=useState('');const [error,setError]=useState('');
  const [loading,setLoading]=useState(false);const [sending,setSending]=useState(false);const [refresh,setRefresh]=useState(0);const [discard,setDiscard]=useState(false);
  const generation=useRef(0);const running=useRef(false);const getting=useRef<number|null>(null);const busy=useRef(false);
  const operation=useRef<{payload:string;key:string}|null>(null);
  const data=record?.owner===owner&&record?.data.goal.id===id?record.data:null;
  const load=useCallback(async(signal:AbortSignal,scope:number,visible:boolean)=>{
    if(!owner||getting.current===scope)return;
    getting.current=scope;if(visible)setLoading(true);
    try{const result=await getDialogue(id,signal);if(signal.aborted||scope!==generation.current)return;running.current=result.runs.some(r=>r.status==='running');setRecord({owner,data:result});}
    catch(err){if(!signal.aborted&&scope===generation.current)setError(err instanceof Error?err.message:'读取对话失败。');}
    finally{if(getting.current===scope)getting.current=null;if(scope===generation.current)setLoading(false);}
  },[id,owner]);
  useFocusEffect(useCallback(()=>{
    void refresh;const scope=++generation.current;const controller=new AbortController();
    setRecord(null);setError('');running.current=false;void load(controller.signal,scope,true);
    const timer=setInterval(()=>{if(running.current)void load(controller.signal,scope,false);},2000);
    const invalidate=()=>{generation.current++;};return()=>{controller.abort();clearInterval(timer);invalidate();};
  },[load,refresh]));
  async function send(override?:string){
    if(!data||!owner||busy.current||data.goal.status!=='draft'||data.runs.some(r=>r.status==='running'))return;
    const value=(override??text).trim();if(!value){setError('请先输入要补充的内容。');return;}
    const body={text:value,expected_chat_revision:data.chat_revision,expected_goal_revision:data.goal.revision};const payload=JSON.stringify(body);
    if(operation.current?.payload!==payload)operation.current={payload,key:`chat_${Date.now()}_${Math.random().toString(36).slice(2,12)}`};
    const scope=generation.current;busy.current=true;setSending(true);setError('');
    try{const result=await sendDialogue(id,body,operation.current.key);if(scope!==generation.current)return;running.current=result.runs.some(r=>r.status==='running');setRecord({owner,data:result});if(value!=='先到这里，请根据现有信息准备方案草稿。')setText('');operation.current=null;}
    catch(err){if(scope!==generation.current)return;setError(err instanceof Error?err.message:'生成失败，输入仍保留。');await load(new AbortController().signal,scope,false);}
    finally{busy.current=false;setSending(false);}
  }
  const active=!!data?.runs.some(r=>r.status==='running');const enabled=data?.goal.status==='draft';
  function leave(){router.replace({pathname:'/goal/[id]',params:{id}});}
  return <KeyboardAvoidingView style={{flex:1,backgroundColor:colors.background}} behavior={Platform.OS==='ios'?'padding':undefined}>
    <Screen title="目标对话" bottomInset footer={data&&<>
      <TextInput accessibilityLabel="回复或补充条件" multiline scrollEnabled maxLength={600} value={text} onChangeText={setText} editable={!!enabled&&!sending&&!active} placeholder="回答上面的问题，或补充新的条件" placeholderTextColor={colors.secondary} style={{backgroundColor:colors.surface,color:colors.text,borderColor:colors.divider,borderWidth:1,borderRadius:15,padding:12,height:104,textAlignVertical:'top',fontSize:17}}/>
      <View style={{flexDirection:'row',gap:8}}>
        <View style={{flex:2}}><Action label={sending?'正在请求…':active?'等待本次生成完成':'发送并继续'} disabled={!enabled||sending||active||!text.trim()} onPress={()=>send()}/></View>
        <View style={{flex:1}}><Action label="暂不确定" secondary disabled={!enabled||sending||active||!data.runs.length||data.runs.at(-1)?.reply?.requested_slot===null} onPress={()=>send('暂不确定，请考虑其他必要条件。')}/></View>
      </View>
    </>}>
      <Action label="返回目标详情" secondary disabled={sending} onPress={()=>text.trim()?setDiscard(true):leave()}/>
      {discard&&<Card><AppText>放弃尚未发送的输入？已发送的消息会保留。</AppText><Action label="放弃并返回" onPress={leave}/><Action label="继续输入" secondary onPress={()=>setDiscard(false)}/></Card>}
      {!owner&&<Caption>请登录后进入目标对话。</Caption>}
      {loading&&<Caption>正在读取对话…</Caption>}
      {!!error&&<AppText accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</AppText>}
      {owner&&<Action label="重新读取对话状态" secondary disabled={sending||loading} onPress={()=>setRefresh(n=>n+1)}/>}
      {data&&<>
        <Badge>与 Agent 制订方案</Badge>
        <Card><AppText>{data.goal.description||data.goal.title}</AppText><Caption>直接回答问题即可。系统会记录明确回答，含糊或未知的信息继续澄清；确认方案前不会写入日历。</Caption></Card>
        {!data.runs.length&&<><Caption>AI 会结合你的目标和已保存条件，一次询问一个重要问题。</Caption><Action label="开始 AI 澄清" disabled={!enabled||sending} onPress={()=>send('请根据我的目标和已确认条件，提出一个必要的澄清问题。')}/></>}
        {data.runs.map(run=><View key={run.id} style={{gap:12}}>
          <Card style={{backgroundColor:colors.action}}><AppText style={{color:colors.onAction}}>{run.user_text}</AppText></Card>
          {run.status==='running'?<Caption>正在生成建议，你的消息已保存。</Caption>:run.status==='failed'?<Card><AppText>这次生成未完成</AppText><Caption>{dialogueError(run.error_code??'')}</Caption><Action label="把这条消息填回输入框" secondary disabled={sending||active} onPress={()=>setText(run.user_text)}/></Card>:run.reply&&<Card><Badge>{run.reply.source==='policy'?'系统安全提示':'Agent'}</Badge><AppText style={{fontSize:21,fontWeight:'600'}}>{run.reply.question}</AppText><Caption>{run.reply.reason}</Caption></Card>}
        </View>)}
        {data.runs.at(-1)?.reply?.stage==='research_ready'&&data.runs.at(-1)?.reply?.requested_slot===null&&<Caption>基本信息已收集。自动研究与方案生成还在接入，这里尚不会安排日历。</Caption>}
        {data.runs.at(-1)?.reply?.stage==='needs_information'&&<Card><Caption>尚有必要信息待确定，可以先保留目标，不会自动安排日历。</Caption><Action label="继续完善" secondary disabled={sending||active||!enabled} onPress={()=>send('请继续澄清仍未明确的条件。')}/></Card>}
        {(data.asked_topics?.length??0)<3&&<Caption>先了解三个核心信息，再停止提问；每项都可以暂不确定。</Caption>}
        {data.runs.at(-1)?.reply?.stage!=='draft_requested'&&<Action label="停止提问，先出草稿" secondary disabled={sending||active||!enabled||(data.asked_topics?.length??0)<3} onPress={()=>send('先到这里，请根据现有信息准备方案草稿。')}/>}
        {data.runs.at(-1)?.reply?.stage==='draft_requested'&&<Action label="继续完善" secondary disabled={sending||active||!enabled} onPress={()=>send('请继续澄清仍未明确的条件。')}/>}
        {!enabled&&<Caption>当前目标只读，暂停草稿请先在详情页继续。</Caption>}
        <Caption>对话会保存在这个目标内。你可以继续补充；已记录条件的更正和自动生成方案将在后续接通。</Caption>
      </>}
    </Screen>
  </KeyboardAvoidingView>;
}
