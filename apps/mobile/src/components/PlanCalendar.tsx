import {useState} from 'react';
import {Pressable,ScrollView,View} from 'react-native';
import {AppText,Caption,Card} from './ui';
import {useTheme} from '../theme/ThemeProvider';
import {scheduleTime,type ScheduleData} from '../goals/schedule';

export function PlanCalendar({schedule,instructions}:{schedule:ScheduleData;instructions:(id:string)=>string|undefined}){
 const {colors}=useTheme();
 const [gridWidth,setGridWidth]=useState(308);
 const [selection,setSelection]=useState({attempt:'',day:'',month:''});
 const offset=schedule.timezone==='UTC'?0:8*3600000;
 const date=(at:number)=>new Date(at+offset).toISOString().slice(0,10);
 const first=date(schedule.period?.start_at??schedule.windows[0].start_at);
 const final=date((schedule.period?.end_at??schedule.windows.at(-1)!.end_at)-1);
 const saved=selection.attempt===schedule.attempt_id;
 const selected=saved&&selection.day>=first&&selection.day<=final?selection.day:first;
 const month=saved&&selection.month>=first.slice(0,7)&&selection.month<=final.slice(0,7)?selection.month:first.slice(0,7);
 const [year,number]=month.split('-').map(Number);
 const leading=(new Date(Date.UTC(year,number-1,1)).getUTCDay()+6)%7;
 const count=new Date(Date.UTC(year,number,0)).getUTCDate();
 const cells=Array.from({length:Math.ceil((leading+count)/7)*7},(_,i)=>i-leading+1);
 const items=schedule.preview?.placements.filter(p=>date(p.start_at)===selected).sort((a,b)=>a.start_at-b.start_at)??[];
 const move=(delta:number)=>{
   const target=new Date(Date.UTC(year,number-1+delta,1)).toISOString().slice(0,7);
   if(target<first.slice(0,7)||target>final.slice(0,7))return;
   setSelection({attempt:schedule.attempt_id,month:target,day:target===first.slice(0,7)?first:target+'-01'});
 };
 const control=(delta:number,label:string,disabled:boolean)=><Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled}} disabled={disabled} onPress={()=>move(delta)} style={{width:44,height:44,justifyContent:'center',alignItems:'center',opacity:disabled?0.25:1}}><AppText style={{fontSize:24}}>{delta<0?'‹':'›'}</AppText></Pressable>;
 return <View style={{gap:24}}>
  <View style={{gap:8}}><AppText style={{fontSize:28,lineHeight:36,fontWeight:'700'}}>你的行动日历</AppText><Caption>{first} — {final} · {schedule.period?Math.round((schedule.period.end_at-schedule.period.start_at)/(7*86400000)):1}周</Caption><Caption>{schedule.window_basis?'暂按北京时间每天20:00–21:00安排。可继续补充没空的时间。':'按已核对时段安排。'}确认前尚未入历。</Caption>{schedule.period_basis==='assumed_one_week_per_stage_v1'&&<Caption>阶段周期暂按各一周，可继续问答调整。</Caption>}</View>
  <View onLayout={event=>{const width=Math.floor(event.nativeEvent.layout.width);if(width>0)setGridWidth(width);}} style={{borderBottomWidth:1,borderBottomColor:colors.divider,paddingBottom:16,gap:12}}>
   <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between'}}><AppText accessibilityRole="header" style={{fontSize:22,fontWeight:'600'}}>{year}年{number}月</AppText><View style={{flexDirection:'row'}}>{control(-1,'上个月',month===first.slice(0,7))}{control(1,'下个月',month===final.slice(0,7))}</View></View>
   <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{width:'100%'}}><View style={{width:Math.max(308,gridWidth)}}>
    <View style={{flexDirection:'row'}}>{['一','二','三','四','五','六','日'].map(day=><View key={day} style={{flex:1,height:32,alignItems:'center',justifyContent:'center'}}><Caption>{day}</Caption></View>)}</View>
    <View style={{flexDirection:'row',flexWrap:'wrap'}}>{cells.map((n,i)=>{
      const value=month+'-'+String(n).padStart(2,'0'),inside=n>=1&&n<=count,enabled=inside&&value>=first&&value<=final;
      const hasTask=schedule.preview?.placements.some(p=>date(p.start_at)===value);
      return <View key={i} style={{width:'14.285714%',minHeight:52,alignItems:'center'}}>{inside&&<Pressable accessibilityRole="button" accessibilityLabel={`查看${value}`} accessibilityState={{selected:value===selected,disabled:!enabled}} disabled={!enabled} onPress={()=>setSelection({attempt:schedule.attempt_id,month,day:value})} style={{width:44,minHeight:52,alignItems:'center',justifyContent:'center',gap:4,opacity:enabled?1:0.3}}><View style={{width:36,height:36,borderRadius:18,alignItems:'center',justifyContent:'center',backgroundColor:value===selected?colors.action:'transparent'}}><AppText style={{fontSize:16,fontWeight:value===selected?'600':'400',color:value===selected?colors.onAction:colors.text}}>{n}</AppText></View><View style={{width:4,height:4,borderRadius:2,backgroundColor:hasTask?colors.text:'transparent'}}/></Pressable>}</View>;
    })}</View>
   </View></ScrollView>
  </View>
  <View style={{gap:16}}><View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center'}}><AppText accessibilityRole="header" style={{fontSize:19,fontWeight:'600'}}>{Number(selected.slice(5,7))}月{Number(selected.slice(8))}日</AppText><Caption>{items.length}项安排</Caption></View>
   {items.map(p=>{const task=schedule.tasks.find(t=>t.id===p.task_id)!;const start=scheduleTime(p.start_at,schedule.timezone).split(' ').at(-1),end=scheduleTime(p.end_at,schedule.timezone).split(' ').at(-1);return <Card key={p.task_id} style={{padding:20}}><View style={{flexDirection:'row',gap:14}}><View style={{width:3,borderRadius:2,backgroundColor:colors.text}}/><View style={{flex:1,gap:10}}><Caption>{start} — {end}{task.stage?` · 阶段${task.stage}`:''}</Caption><AppText style={{fontSize:20,lineHeight:27,fontWeight:'600'}}>{task.title}</AppText><AppText>{instructions(task.series_id??task.id)}</AppText><Caption>{task.duration_minutes}分钟 · 建议安排</Caption></View></View></Card>;})}
   {!items.length&&<View style={{paddingVertical:24,gap:8}}><AppText>这天留白</AppText><Caption>没有安排任务，可以休息或补充你的时间偏好。</Caption></View>}
  </View>
  {!!schedule.preview?.unplaced.length&&<Card><AppText>{schedule.preview.unplaced.length}次任务需要调整</AppText><Caption>现有时段放不下全部任务。可以继续告诉 Guidy 你的时间偏好，再核对方案。</Caption></Card>}
 </View>;
}
