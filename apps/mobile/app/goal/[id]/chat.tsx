import {GuidyCards} from '../../../src/components/GuidyCards';
import {isBusyText} from '../../../src/goals/calendar';
import {ASK_AUTO,ASK_SCHEDULE,ASK_WEEK,CONFIRM_SCHEDULE,CONFIRM_WEEK,isScheduleText} from '../../../src/goals/schedule';
import {AutomaticPlanning} from '../../../src/components/AutomaticPlanning';
import { useCallback, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';

import { Action, AppText, Screen } from '../../../src/components/ui';
import { useAccount } from '../../../src/auth/AuthProvider';
import { getDialogue, sendDialogue } from '../../../src/goals/api';
import { isDraftEditText, dialogueError, type Dialogue } from '../../../src/goals/dialogue';

export default function GoalChat(){
  const {id}=useLocalSearchParams<{id:string}>();const {user}=useAccount();
  return <GoalChatBody key={`${user?.id??'anonymous'}:${id}`} id={id} owner={user?.id}/>;
}
function GoalChatBody({id,owner}:{id:string;owner:string|undefined}){

  const [record,setRecord]=useState<{owner:string;data:Dialogue}|null>(null);const [text,setText]=useState('');const [error,setError]=useState('');
  const [loading,setLoading]=useState(false);const [sending,setSending]=useState(false);const [refresh,setRefresh]=useState(0);
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
  function busyInput(value:string){return isBusyText(value)||(['busy_guidance','busy_proposed'].includes(data?.runs.at(-1)?.reply?.stage??'')&&!['我想调整未来的安排。','请重新检查这份调整的日程。','请继续问我一个有助于完善方案的问题。'].includes(value)&&!isDraftEditText(value)&&![ASK_AUTO,ASK_SCHEDULE,ASK_WEEK,CONFIRM_SCHEDULE,CONFIRM_WEEK].includes(value)&&!/^可用时段[：:]/.test(value)&&value!=='请继续澄清仍未明确的条件。'&&value!=='先到这里，请根据现有信息准备方案草稿。');}
  function scheduleInput(value:string){return isScheduleText(value)||(['schedule_guidance','schedule_proposed'].includes(data?.runs.at(-1)?.reply?.stage??'')&&!isDraftEditText(value)&&value!=='请继续澄清仍未明确的条件。'&&value!=='先到这里，请根据现有信息准备方案草稿。');}
  async function send(override?:string, fixedKey?:string){
    if(!data||!owner||busy.current||!['draft','active'].includes(data.goal.status)||data.runs.some(r=>r.status==='running'))return;
    const value=(override??text).trim();if(data.clarification_budget?.allowed===false&&value!=='先到这里，请根据现有信息准备方案草稿。'&&!value.startsWith('根据当前回答开始制订：')&&!isDraftEditText(value)&&!scheduleInput(value)&&!busyInput(value)){setError(dialogueError(data.clarification_budget.global_limited?'AI_GLOBAL_LIMIT':'AI_DAILY_LIMIT'));return;}if(!value){setError('请先输入要补充的内容。');return;}
    const body={text:value,expected_chat_revision:data.chat_revision,expected_goal_revision:data.goal.revision};const payload=JSON.stringify(body);
    if(operation.current?.payload!==payload)operation.current={payload,key:fixedKey??`chat_${Date.now()}_${Math.random().toString(36).slice(2,12)}`};
    const scope=generation.current;busy.current=true;setSending(true);setError('');
    try{const result=await sendDialogue(id,body,operation.current.key);if(scope!==generation.current)return;running.current=result.runs.some(r=>r.status==='running');setRecord({owner,data:result});if(override===undefined)setText('');operation.current=null;}
    catch(err){if(scope!==generation.current)return;setError(err instanceof Error?err.message:'生成失败，输入仍保留。');await load(new AbortController().signal,scope,false);}
    finally{busy.current=false;setSending(false);}
  }

  const active=!!data?.runs.some(r=>r.status==='running');const enabled=!!data&&['draft','active'].includes(data.goal.status);
  function leave(){router.replace('/(tabs)/goals');}
  if(!data)return <Screen title="Guidy!"><AppText>{error||'正在读取目标…'}</AppText><Action label="重新读取" secondary onPress={()=>setRefresh(n=>n+1)}/></Screen>;
  return <GuidyCards data={data} text={text} onText={setText} onSend={send} onBack={leave} error={error||(data.runs.at(-1)?.status==='failed'?dialogueError(data.runs.at(-1)?.error_code??''):'')} busy={sending||loading||active} reload={()=>setRefresh(n=>n+1)} result={<AutomaticPlanning key={owner+':'+id} id={id} owner={owner} chatRevision={data.chat_revision} stopped={data.runs.at(-1)?.reply?.stage==='draft_requested'} stopRunId={data.runs.filter(r=>r.reply?.stage==='draft_requested').at(-1)?.id} calendarRevision={data.calendar_revision} automaticSchedule={data.auto_schedule} automaticScheduleRunId={data.auto_schedule_run_id} onRefresh={()=>setRefresh(n=>n+1)} onAutoSchedule={key=>{void send(data.goal.status==='active'?'请重新检查这份调整的日程。':ASK_AUTO,data.goal.status==='active'?undefined:key);}} canSchedule={!!enabled&&!sending&&!active&&!data.runs.some(r=>r.reply?.source==='policy')} onAnother={()=>{void send('先到这里，请根据现有信息准备方案草稿。');}}/>}/>;
}
