import {useEffect,useRef,useState} from 'react';
import {ActivityIndicator,Keyboard,KeyboardAvoidingView,Modal,Platform,Pressable,ScrollView,TextInput,View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {AgendaScroll} from './AgendaScroll';
import {QuestionHistory} from './QuestionHistory';
import {Action,AppText,Caption,Card} from './ui';
import {useTheme} from '../theme/ThemeProvider';
import type {Dialogue} from '../goals/dialogue';
import {ASK_AUTO} from '../goals/schedule';
import {shouldShowPlan} from '../goals/plan-presentation';
import {createCalendarEvent,discuss,getDiscussion,type DiscussionTurn} from '../goals/api';
export const MORE_QUESTIONS='请继续问我一个有助于完善方案的问题。';
const START='请根据我的目标和已确认条件，提出一个必要的澄清问题。';
const controls=new Set([START,ASK_AUTO,MORE_QUESTIONS,'先到这里，请根据现有信息准备方案草稿。','制订21天策略。']);
function visibleText(text:string){return controls.has(text)?'':text.replace(/^(根据当前回答(?:开始制订|制订21天策略)：|按讨论修改策略：)/,'');}
export function GuidyCards({data,text,onText,onSend,onBack,error,busy,reload,result,openChat=false}:{openChat?:boolean;data:Dialogue;text:string;onText:(s:string)=>void;onSend:(s?:string)=>Promise<void>;onBack:()=>void;error:string;busy:boolean;reload:()=>void;result:React.ReactNode}){
 const {colors}=useTheme(),scroll=useRef<ScrollView>(null),started=useRef(false),lock=useRef(false);
 const [historyOpen,setHistoryOpen]=useState(false),[discard,setDiscard]=useState(false),[view,setView]=useState<'chat'|'plan'|null>(openChat?'chat':null);
 const [turns,setTurns]=useState<DiscussionTurn[]>([]),[discussing,setDiscussing]=useState(false),[localError,setLocalError]=useState(''),[saved,setSaved]=useState<string[]>([]);
 const operation=useRef<{text:string;key:string}|null>(null);
 const hasStrategy=!!data.auto_schedule||data.goal.status==='active';
 const plan=view==='plan'||view===null&&shouldShowPlan(data);
 const enabled=['draft','active'].includes(data.goal.status),blocked=data.runs.some(r=>r.reply?.source==='policy');
 const answers=data.runs.filter(r=>r.status==='succeeded'&&r.reply?.source==='deepseek'&&visibleText(r.user_text)).length;
 const ready=(data.asked_topics?.length??0)>=3&&(answers>=3||answers>=2&&!!text.trim());
 useEffect(()=>{if(!started.current&&!busy&&data.runs.length===0&&data.goal.status==='draft'){started.current=true;void onSend(START);}},[busy,data.runs.length,data.goal.status,onSend]);
 useEffect(()=>{const c=new AbortController();void getDiscussion(data.goal.id,c.signal).then(setTurns).catch(()=>{if(!c.signal.aborted)setLocalError('讨论记录暂未读取，请重新打开。');});return()=>c.abort();},[data.goal.id]);
 const pendingDiscussion=turns.some(t=>t.status==='running');
 useEffect(()=>{if(!pendingDiscussion)return;const c=new AbortController();let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{const next=await getDiscussion(data.goal.id,c.signal);if(!c.signal.aborted)setTurns(next);}catch{/* A read failure must never trigger another model call. */}if(!c.signal.aborted)timer=setTimeout(()=>void poll(),3000);};timer=setTimeout(()=>void poll(),3000);return()=>{c.abort();clearTimeout(timer);};},[data.goal.id,pendingDiscussion]);
 async function send(){if(lock.current)return;if(!hasStrategy){await onSend();return;}lock.current=true;setDiscussing(true);setLocalError('');const value=text.trim();if(operation.current?.text!==value)operation.current={text:value,key:'discussion_'+Date.now()+'_'+Math.random().toString(36).slice(2)};try{const next=await discuss(data.goal.id,value,data.goal.revision,operation.current.key);setTurns(next);if(next.at(-1)?.status==='succeeded')onText('');else setLocalError('这次回复暂未完成，输入已保留。');if(next.at(-1)?.status!=='running')operation.current=null;}catch(e){setLocalError(e instanceof Error?e.message:'消息未发送。');try{const next=await getDiscussion(data.goal.id);setTurns(next);if(next.at(-1)?.status==='failed')operation.current=null;}catch{/* Preserve messages and input. */}}finally{lock.current=false;setDiscussing(false);}}
 async function add(turn:DiscussionTurn){if(lock.current||!turn.reply?.event)return;lock.current=true;setDiscussing(true);setLocalError('');try{await createCalendarEvent(turn.reply.event,data.calendar_revision??0,'discussion_event_'+turn.id,turn.id);setSaved(v=>[...v,turn.id]);reload();}catch(e){setLocalError(e instanceof Error?e.message:'日程未添加。');}finally{lock.current=false;setDiscussing(false);}}
 async function begin(){Keyboard.dismiss();setView('plan');await onSend(text.trim()?'根据当前回答制订21天策略：'+text.trim():'制订21天策略。');}
 const working=busy||discussing||pendingDiscussion;
 return <KeyboardAvoidingView style={{flex:1,backgroundColor:colors.background}} behavior={Platform.OS==='ios'?'padding':undefined}><SafeAreaView edges={['top','bottom','left','right']} style={{flex:1,width:'100%',maxWidth:600,alignSelf:'center'}}>
  <View style={{paddingHorizontal:16,paddingVertical:8,flexDirection:'row',alignItems:'center',gap:12}}>
   <Pressable accessibilityRole="button" accessibilityLabel="返回目标" onPress={()=>text.trim()?setDiscard(true):onBack()} style={{minWidth:44,minHeight:44,justifyContent:'center'}}><AppText style={{fontSize:28}}>‹</AppText></Pressable>
   <View style={{flex:1}}><AppText numberOfLines={1} style={{fontWeight:'600',fontSize:17}}>{data.goal.title}</AppText><Caption>Guidy · 一起把想法变成行动</Caption></View>
   <Pressable accessibilityRole="button" accessibilityLabel="回看全部回答" onPress={()=>{Keyboard.dismiss();setHistoryOpen(true);}} style={{minHeight:44,justifyContent:'center'}}><Caption>回看</Caption></Pressable>
  </View>
  {hasStrategy&&<View style={{flexDirection:'row',paddingHorizontal:24,gap:24,paddingBottom:8}}>{(['chat','plan'] as const).map(v=><Pressable key={v} accessibilityRole="button" accessibilityState={{selected:(plan?'plan':'chat')===v}} onPress={()=>{Keyboard.dismiss();setView(v);}} style={{paddingVertical:12,borderBottomWidth:(plan?'plan':'chat')===v?2:0,borderBottomColor:colors.text}}><AppText style={{fontSize:14,color:(plan?'plan':'chat')===v?colors.text:colors.secondary}}>{v==='chat'?'一起聊聊':'方案策略'}</AppText></Pressable>)}</View>}
  {!!(error||localError)&&<View style={{paddingHorizontal:24,paddingVertical:8}}><AppText accessibilityRole="alert" style={{fontSize:14}}>{localError||error}</AppText><Pressable accessibilityRole="button" onPress={reload} style={{minHeight:44,justifyContent:'center'}}><Caption>重新读取</Caption></Pressable></View>}
  {plan?<AgendaScroll contentContainerStyle={{padding:24,gap:24}}>{result}<Action label="继续聊聊" secondary onPress={()=>setView('chat')}/></AgendaScroll>:<>
   <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" onContentSizeChange={()=>scroll.current?.scrollToEnd({animated:false})} contentContainerStyle={{padding:24,gap:24,paddingBottom:32}}>
    <View style={{alignSelf:'flex-start',gap:6}}><Caption>Guidy</Caption><AppText style={{fontSize:18,lineHeight:28}}>这次，你想制订什么计划？</AppText></View>
    <Bubble>{data.goal.description||data.goal.title}</Bubble>
    {!hasStrategy&&!data.runs.some(r=>r.reply?.kind==='question')&&data.runs.some(r=>r.status==='failed')&&<Action label="重新开始提问" secondary disabled={working} onPress={()=>void onSend(START)}/>}
    {data.runs.map(r=><View key={r.id} style={{gap:24}}>{!!visibleText(r.user_text)&&<Bubble>{visibleText(r.user_text)}</Bubble>}{r.reply?.kind==='question'||r.reply?.kind==='referral'?<View style={{gap:6,paddingRight:20}}><Caption>Guidy</Caption><AppText style={{fontSize:17,lineHeight:27}}>{r.reply.question}</AppText></View>:null}</View>)}
    {turns.map(t=><View key={t.id} style={{gap:20}}><Bubble>{t.user_text}</Bubble>{t.reply&&<View style={{gap:12,paddingRight:8}}><Caption>Guidy</Caption><AppText style={{fontSize:17,lineHeight:27}}>{t.reply.message}</AppText>{t.reply.event&&<Card><AppText style={{fontWeight:'600'}}>{t.reply.event.title}</AppText><Caption>{new Date(t.reply.event.start_at).toLocaleString('zh-CN',{timeZone:t.reply.event.timezone})} — {new Date(t.reply.event.end_at).toLocaleTimeString('zh-CN',{timeZone:t.reply.event.timezone,hour:'2-digit',minute:'2-digit'})}</Caption><Action label={(saved.includes(t.id)||!!t.saved_event_id)?'已加入日历':'确认新增事件'} disabled={working||(saved.includes(t.id)||!!t.saved_event_id)||t.goal_revision!==data.goal.revision} onPress={()=>void add(t)}/></Card>}{t.reply.revision&&<Action label="按这个方向修改策略" secondary disabled={working||t.goal_revision!==data.goal.revision} onPress={()=>{setView('plan');void onSend('按讨论修改策略：'+t.reply!.revision);}}/>}</View>}{t.status==='failed'&&<Caption>这条消息暂未得到回复，可以重新发送。</Caption>}</View>)}
    {working&&<View style={{flexDirection:'row',gap:8,alignItems:'center'}}><ActivityIndicator size="small" color={colors.secondary}/><Caption>Guidy 正在想…</Caption></View>}
   </ScrollView>
   <View style={{paddingHorizontal:20,paddingBottom:12,paddingTop:8,gap:10}}>
    {!hasStrategy&&<Caption>{Math.min(answers,3)<3?`已聊 ${Math.min(answers,3)} 轮 · 三轮后开始制订`:'已经了解你的想法，可以制订策略了'}</Caption>}
    <View style={{flexDirection:'row',alignItems:'flex-end',gap:8,padding:8,paddingLeft:16,backgroundColor:colors.surface,borderRadius:24,borderWidth:1,borderColor:colors.divider}}>
     <TextInput accessibilityLabel="回答Agent的问题" placeholder={hasStrategy?'讨论方案，或告诉我想添加的日程…':'和 Guidy 聊聊…'} placeholderTextColor={colors.secondary} multiline maxLength={500} value={text} onChangeText={onText} editable={!working&&enabled&&!blocked} style={{flex:1,minHeight:40,maxHeight:132,paddingVertical:10,color:colors.text,fontSize:16,lineHeight:23}}/>
     <Pressable accessibilityRole="button" accessibilityLabel="发送回答并继续" disabled={working||!text.trim()||!enabled||blocked} onPress={()=>void send()} style={({pressed})=>({width:44,height:44,borderRadius:22,alignItems:'center',justifyContent:'center',backgroundColor:colors.action,opacity:working||!text.trim().length?0.35:pressed?0.75:1})}><AppText style={{color:colors.onAction,fontSize:25,lineHeight:30}}>↑</AppText></Pressable>
    </View>
    {!hasStrategy&&<Action label="制订21天策略" disabled={!ready||working||blocked||!enabled} onPress={()=>void begin()}/>}
   </View>
  </>}
  {historyOpen&&<QuestionHistory goalId={data.goal.id} onClose={()=>setHistoryOpen(false)}/>}
  <Modal transparent visible={discard} onRequestClose={()=>setDiscard(false)}><View style={{flex:1,backgroundColor:'rgba(0,0,0,0.3)',justifyContent:'center',padding:24}}><Card><AppText>还有一条未发送的消息。</AppText><Action label="继续聊天" onPress={()=>setDiscard(false)}/><Action label="放弃并离开" secondary onPress={onBack}/></Card></View></Modal>
 </SafeAreaView></KeyboardAvoidingView>;
}
function Bubble({children}:{children:React.ReactNode}){const {colors}=useTheme();return <View style={{alignSelf:'flex-end',maxWidth:'88%',backgroundColor:colors.divider,borderRadius:18,borderBottomRightRadius:5,paddingHorizontal:16,paddingVertical:12}}><AppText style={{fontSize:16,lineHeight:25}}>{children}</AppText></View>;}
