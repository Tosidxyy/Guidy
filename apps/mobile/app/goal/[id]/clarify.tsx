import { useCallback, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { Action, AppText, Badge, Caption, Card, Screen, SectionTitle } from '../../../src/components/ui';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { useAccount } from '../../../src/auth/AuthProvider';
import { getConditions, saveConditions, GoalApiError, type GoalConditions } from '../../../src/goals/api';
import { emptySlots, questions, type SlotInput } from '../../../src/goals/clarification';

export default function ClarifyGoal() {
  const { id } = useLocalSearchParams<{id:string}>();
  const { user } = useAccount(); const owner = user?.id;
  const { colors } = useTheme();
  const [record,setRecord] = useState<{owner:string;data:GoalConditions}|null>(null);
  const [slots,setSlots] = useState<SlotInput[]>(emptySlots);
  const [step,setStep] = useState(0);
  const [error,setError] = useState(''); const [notice,setNotice] = useState('');
  const [loading,setLoading] = useState(false); const [saving,setSaving] = useState(false);
  const [conflict,setConflict] = useState(false); const [refresh,setRefresh] = useState(0);
  const [discard,setDiscard] = useState(false);
  const generation = useRef(0); const preserve = useRef<string | null>(null); const busy = useRef(false);
  const operation = useRef<{payload:string;key:string}|null>(null);
  const data = record?.owner === owner && record?.data.goal.id === id ? record.data : null;
  useFocusEffect(useCallback(()=>{
    void refresh; const current=++generation.current;const controller=new AbortController();
    setLoading(!!owner);setError('');setNotice('');setRecord(null);
    if(owner) getConditions(id,controller.signal).then(result=>{
      if(controller.signal.aborted)return;
      setRecord({owner,data:result});
      if(preserve.current !== `${owner}:${id}`)setSlots(questions.map(q=>{const saved=result.slots.find(s=>s.key===q.key);return {key:q.key,state:saved?.value.state??'unknown',text:saved?.value.text??''};}));
      else setNotice('已读取最新版本并保留输入，请核对后再次确认。');
      preserve.current=null;operation.current=null;setConflict(false);
    }).catch(err=>{if(!controller.signal.aborted)setError(err instanceof Error?err.message:'读取条件失败。');})
      .finally(()=>{if(current===generation.current&&!controller.signal.aborted)setLoading(false);});
    const invalidate=()=>{generation.current++;};return()=>{controller.abort();invalidate();};
  },[id,owner,refresh]));
  const savedInputs = questions.map(q=>{const saved=data?.slots.find(s=>s.key===q.key);return {key:q.key,state:saved?.value.state??'unknown',text:saved?.value.text??''};});
  const dirty = !!data && JSON.stringify(slots)!==JSON.stringify(savedInputs);
  function leave(){router.replace({pathname:'/goal/[id]',params:{id}});}
  function change(text:string){setSlots(old=>old.map((s,i)=>i===step?{...s,text,state:text.trim()?'confirmed':'unknown'}:s));setError('');setNotice('');}
  async function confirm(){
    if(!data||data.goal.status!=='draft'||busy.current||conflict)return;
    const body={expected_revision:data.goal.revision,slots:slots.map(s=>({...s,text:s.text.trim()}))};
    const payload=JSON.stringify(body);if(operation.current?.payload!==payload)operation.current={payload,key:`slots_${Date.now()}_${Math.random().toString(36).slice(2,12)}`};
    const current=generation.current;busy.current=true;setSaving(true);setError('');setNotice('');
    try{const result=await saveConditions(id,body,operation.current.key);if(current!==generation.current)return;setRecord({owner:owner!,data:result});setSlots(body.slots);operation.current=null;setNotice('条件已保存，之后可以继续补充或修改。');}
    catch(err){if(current!==generation.current)return;setError(err instanceof Error?err.message:'保存失败，输入仍保留。');if(err instanceof GoalApiError)setConflict(true);}
    finally{busy.current=false;setSaving(false);}
  }
  const editable=data?.goal.status==='draft';const q=questions[step];const currentSlot=slots[step];
  const currentSaved=data?.slots.find(s=>s.key===currentSlot.key);
  const matchesSaved=!!currentSaved&&currentSaved.value.state===currentSlot.state&&currentSaved.value.text===currentSlot.text;
  return <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==='ios'?'padding':undefined}>
    <Screen title="澄清目标" bottomInset>
      <Action label="返回目标详情" secondary disabled={saving} onPress={()=>dirty?setDiscard(true):leave()} />
      {discard&&<Card><AppText>放弃尚未保存的条件？</AppText><Action label="放弃并返回" onPress={leave}/><Action label="继续填写" secondary onPress={()=>setDiscard(false)}/></Card>}
      {!owner&&<Caption>请登录后补充账号目标的条件。</Caption>}
      {loading&&<Caption>正在读取已保存条件…</Caption>}
      {!!error&&<AppText accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</AppText>}
      {!!notice&&<AppText accessibilityLiveRegion="polite">{notice}</AppText>}
      {owner&&!loading&&(conflict||!data)&&<Action label={conflict?'读取最新版本（保留输入）':'重新读取条件'} secondary disabled={saving} onPress={()=>{preserve.current=conflict?`${owner}:${id}`:null;setRefresh(n=>n+1);}}/>}
      {data&&<>
        <Badge>条件确认 · {step+1} / 3</Badge>
        <Card style={{backgroundColor:colors.action}}><AppText style={{color:colors.onAction}}>{data.goal.description||data.goal.title}</AppText></Card>
        {!editable&&<Caption>当前阶段只读。暂停的草稿可先在详情页继续，其他阶段暂不可修改条件。</Caption>}
        <Card>
          <SectionTitle>{q.question}</SectionTitle>
          <TextInput accessibilityLabel={q.label} multiline maxLength={300} value={currentSlot.text} onChangeText={change} editable={editable&&!saving&&!loading} placeholder={q.hint} placeholderTextColor={colors.secondary} style={{backgroundColor:colors.subtle,color:colors.text,minHeight:130,textAlignVertical:'top',padding:16,borderRadius:15,fontSize:17}}/>
          <Caption>{currentSlot.text.length} / 300 · {currentSlot.state==='unknown'?(matchesSaved?'暂不确定，已保存':'暂不确定，待保存'):(matchesSaved?'已确认，来自你':'已填写，待确认保存')}</Caption>
          <Action label="暂不确定" secondary disabled={!editable||saving} onPress={()=>change('')}/>
        </Card>
        <View style={{gap:8}}>{step>0&&<Action label="上一项" secondary disabled={saving} onPress={()=>setStep(n=>n-1)}/>}{step<2?<Action label="下一项" disabled={saving} onPress={()=>setStep(n=>n+1)}/>:<Action label={saving?'正在保存…':'确认并保存条件'} disabled={!editable||saving||conflict||(!dirty&&data.slots.length===3)} onPress={confirm}/>}</View>
        <SectionTitle>已保存的条件</SectionTitle>
        {data.slots.length===0?<Caption>尚未保存条件，填写后请确认保存。</Caption>:<Card>{questions.map(item=>{const saved=data.slots.find(s=>s.key===item.key);return <View key={item.key}><AppText>{item.label} · {saved?.value.state==='confirmed'?'已确认，来自你':'暂不确定'}</AppText>{saved?.value.state==='confirmed'&&<Caption>{saved.value.text}</Caption>}</View>;})}</Card>}
        <Caption>离开前请确认保存。当前收集你的条件，尚未接入 AI 动态问答或生成计划；时间说明不会直接写入日历。</Caption>
      </>}
    </Screen>
  </KeyboardAvoidingView>;
}
