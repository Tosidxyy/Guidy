import {AgendaScroll} from './AgendaScroll';
import {QuestionHistory} from './QuestionHistory';
import {useEffect,useRef,useState} from 'react';
import {Keyboard,KeyboardAvoidingView,Modal,Platform,Pressable,ScrollView,TextInput,useWindowDimensions,View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {Action,AppText,Caption,Card} from './ui';
import {useTheme} from '../theme/ThemeProvider';
import type {Dialogue} from '../goals/dialogue';
import {ASK_AUTO} from '../goals/schedule';
import {shouldShowPlan} from '../goals/plan-presentation';
import {currentQuestion} from '../goals/question-recovery';
export const MORE_QUESTIONS='请继续问我一个有助于完善方案的问题。';
export function GuidyCards({data,text,onText,onSend,onBack,error,busy,reload,result}:{data:Dialogue;text:string;onText:(s:string)=>void;onSend:(s?:string)=>Promise<void>;onBack:()=>void;error:string;busy:boolean;reload:()=>void;result:React.ReactNode}){
 const [historyOpen,setHistoryOpen]=useState(false);
 const [discard,setDiscard]=useState(false),[questionStartRunId,setQuestionStartRunId]=useState('');
 const {colors}=useTheme(),{width}=useWindowDimensions(),viewport=Math.min(width,600);
 const started=useRef(false);useEffect(()=>{if(!started.current&&!busy&&data.runs.length===0&&data.goal.status==='draft'){started.current=true;void onSend('请根据我的目标和已确认条件，提出一个必要的澄清问题。');}},[busy,data.runs.length,data.goal.status,onSend]);
 const [pagerHeight,setPagerHeight]=useState(0);
 const questions=data.runs.filter(r=>r.reply?.kind==='question'||r.reply?.kind==='referral');
 const [keyboardOpen,setKeyboardOpen]=useState(false);useEffect(()=>{const a=Keyboard.addListener("keyboardDidShow",()=>setKeyboardOpen(true)),b=Keyboard.addListener("keyboardDidHide",()=>setKeyboardOpen(false));return()=>{a.remove();b.remove();};},[]);
 const [selection,setSelection]=useState({count:questions.length,index:Math.max(0,questions.length-1)}),[showPlan,setShowPlan]=useState(false),[forceQuestions,setForceQuestions]=useState(false);
 const scroll=useRef<ScrollView|null>(null);useEffect(()=>{scroll.current?.scrollTo({x:Math.max(0,questions.length-1)*viewport,animated:true});},[questions.length,viewport]);
 const index=selection.count===questions.length?selection.index:Math.max(0,questions.length-1);
 const last=data.runs.at(-1),ready=(data.asked_topics?.length??0)>=3,enabled=['draft','active'].includes(data.goal.status);
 const editableQuestion=currentQuestion(data),retrying=last?.status==='failed';
 const blocked=data.runs.some(r=>r.reply?.source==='policy');
 const autoResult=['draft_requested','schedule_preview'].includes(last?.reply?.stage??'')&&last?.id!==questionStartRunId;
 const plan=shouldShowPlan(data,showPlan||autoResult,autoResult?false:forceQuestions);
 function openHistory(){Keyboard.dismiss();setHistoryOpen(true);}
 async function begin(){setShowPlan(true);setForceQuestions(false);await onSend(text.trim()?'根据当前回答开始制订：'+text.trim():'先到这里，请根据现有信息准备方案草稿。');}
 async function more(){setQuestionStartRunId(last?.id??'');setShowPlan(false);setForceQuestions(true);await onSend(text.trim()&&editableQuestion?undefined:MORE_QUESTIONS);}
 return <KeyboardAvoidingView style={{flex:1,backgroundColor:colors.background}} behavior={Platform.OS==='ios'?'padding':undefined}><SafeAreaView style={{flex:1}} edges={['top','bottom','left','right']}>
 <View style={{padding:20,flexDirection:'row',alignItems:'center',justifyContent:'space-between'}}><Pressable accessibilityRole="button" accessibilityLabel="返回目标" onPress={()=>text.trim()?setDiscard(true):onBack()} style={{minWidth:44,minHeight:44,alignItems:'center',justifyContent:'center'}}><AppText style={{fontSize:28}}>‹</AppText></Pressable><AppText style={{fontSize:22,fontWeight:'700',flex:1,textAlign:'center'}}>Guidy!</AppText><Pressable accessibilityRole="button" accessibilityLabel="回看全部回答" disabled={busy||data.chat_revision===0} onPress={openHistory} style={{minWidth:56,minHeight:44,alignItems:'flex-end',justifyContent:'center'}}><Caption>{plan||data.goal.status==='active'?'回看':Math.min(data.asked_topics?.length??0,3)+' / 3 · 回看'}</Caption></Pressable></View>
 {!!error&&<View style={{paddingHorizontal:20,gap:8}}><AppText accessibilityRole="alert">{error}</AppText><Action label="重新读取" secondary disabled={busy} onPress={reload}/></View>}
 {plan?<AgendaScroll contentContainerStyle={{padding:20,gap:16}} keyboardShouldPersistTaps="handled">{result}{<Action label="回看回答" secondary disabled={busy} onPress={openHistory}/>}{enabled&&<Action label="继续问答" disabled={busy||!enabled} onPress={()=>{void more();}}/>}</AgendaScroll>:<>
 {data.goal.status==='draft'&&<View style={{marginHorizontal:20,height:4,borderRadius:2,backgroundColor:colors.divider,marginBottom:20}}><View style={{height:4,borderRadius:2,width:`${Math.min(data.asked_topics?.length??0,3)/3*100}%`,backgroundColor:colors.action}}/></View>}
 {!questions.length?<View style={{flex:1,padding:20,justifyContent:'center',gap:24}}><AppText style={{fontSize:28,fontWeight:'600'}}>把想做的事，交给Guidy。</AppText><Caption>{data.goal.description||data.goal.title}</Caption><Action label={busy?'正在准备…':'Guidy！'} disabled={busy||!enabled} onPress={()=>{void onSend('请根据我的目标和已确认条件，提出一个必要的澄清问题。');}}/></View>:<ScrollView ref={scroll} onLayout={e=>setPagerHeight(e.nativeEvent.layout.height)} horizontal pagingEnabled contentContainerStyle={{height:"100%"}} showsHorizontalScrollIndicator={false} onMomentumScrollEnd={e=>setSelection({count:questions.length,index:Math.round(e.nativeEvent.contentOffset.x/viewport)})} style={{flex:1}} keyboardShouldPersistTaps="handled">
 {questions.map((q,i)=>{const position=data.runs.findIndex(r=>r.id===q.id),next=data.runs[position+1],answer=next&&![ASK_AUTO,MORE_QUESTIONS,'请根据我的目标和已确认条件，提出一个必要的澄清问题。'].includes(next.user_text)&&next.user_text!=='先到这里，请根据现有信息准备方案草稿。'?next.user_text.replace(/^根据当前回答开始制订：/,''):undefined;const current=i===questions.length-1&&editableQuestion?.id===q.id&&q.reply?.kind==='question';return <View key={q.id} style={{width:viewport,height:pagerHeight||undefined,paddingHorizontal:20,paddingBottom:16}}><Card style={{flex:1,padding:24}}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{gap:20,flexGrow:1}}><Caption>问题 {i+1} · 左右滑动回看</Caption><AppText style={{fontSize:24,lineHeight:32,fontWeight:'600'}}>{q.reply?.question}</AppText>{current?<TextInput accessibilityLabel="回答Agent的问题" multiline maxLength={500} value={text} onChangeText={onText} editable={!busy&&enabled} placeholder="写下你的回答…" placeholderTextColor={colors.secondary} style={{flex:1,minHeight:130,padding:16,fontSize:18,color:colors.text,backgroundColor:colors.subtle,borderRadius:16,textAlignVertical:'top'}}/>:<AppText>{answer??'尚未回答'}</AppText>}{current&&retrying&&<Caption>回答已保留。点击箭头重试会重新调用 AI。</Caption>}{current&&q.reply?.stage==='refine_question'&&<Caption>提交后会重新制订，原方案仍保留。</Caption>}{current&&<Pressable accessibilityRole="button" accessibilityLabel={retrying?'重试回答并继续':q.reply?.stage==='refine_question'?'提交修改并重新制订':'发送回答并继续'} disabled={busy||!text.trim()||!enabled} onPress={()=>{Keyboard.dismiss();void onSend();}} style={{backgroundColor:colors.action,opacity:busy||!text.trim()?0.5:1,width:64,height:64,borderRadius:32,alignItems:'center',justifyContent:'center',alignSelf:'center'}}><AppText style={{color:colors.onAction,fontSize:28}}>→</AppText></Pressable>}</ScrollView></Card></View>;})}
 </ScrollView>}
 {questions.length>0&&<Caption>　{index+1} / {questions.length} 张问答卡片</Caption>}
 {data.goal.status==='draft'&&ready&&!keyboardOpen&&last?.reply?.stage!=='refine_question'&&<View style={{padding:20,gap:10}}><Action label={busy?'正在处理…':'开始制订'} disabled={busy||!enabled||blocked} onPress={()=>{void begin();}}/><Action label="继续问答" secondary disabled={busy||!enabled} onPress={()=>{void more();}}/></View>}
 </>}
 {!plan&&last?.reply?.stage==='refine_question'&&<View style={{padding:20}}><Action label="保留当前方案" secondary onPress={()=>{setShowPlan(true);setForceQuestions(false);}}/></View>}
 {!plan&&data.goal.status==='active'&&questions.length>0&&<View style={{padding:20}}><Action label="返回方案" onPress={()=>{setShowPlan(true);setForceQuestions(false);}}/></View>}
 {historyOpen&&<QuestionHistory key={data.goal.id} goalId={data.goal.id} onClose={()=>setHistoryOpen(false)}/>}
 <Modal transparent visible={discard} onRequestClose={()=>setDiscard(false)}><View style={{flex:1,backgroundColor:"rgba(0,0,0,0.3)",justifyContent:"center",padding:24}}><Card><AppText>当前回答尚未发送，离开后会丢失。</AppText><Action label="继续回答" onPress={()=>setDiscard(false)}/><Action label="放弃并离开" secondary onPress={()=>{setDiscard(false);onBack();}}/></Card></View></Modal>
 </SafeAreaView></KeyboardAvoidingView>;
}
