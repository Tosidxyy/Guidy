import {CalendarMonth} from './CalendarMonth';
import {useState} from 'react';
import {View} from 'react-native';
import {AppText,Caption,Card} from './ui';
import {useTheme} from '../theme/ThemeProvider';
import {scheduleTime,type ScheduleData} from '../goals/schedule';

export function PlanCalendar({schedule,instructions,approved=false}:{approved?:boolean;schedule:ScheduleData;instructions:(id:string)=>string|undefined}){
 const {colors}=useTheme();
 const [selection,setSelection]=useState({attempt:'',day:'',month:''});
 const offset=schedule.timezone==='UTC'?0:8*3600000;
 const date=(at:number)=>new Date(at+offset).toISOString().slice(0,10);
 const remaining=schedule.scope==='remaining_plan_v1';
 const first=date(remaining?Math.min(...(schedule.preview?.placements.length?schedule.preview.placements.map(p=>p.start_at):schedule.tasks.map(t=>t.earliest_at!))):schedule.period?.start_at??schedule.windows[0].start_at);
 const final=date((schedule.period?.end_at??schedule.windows.at(-1)!.end_at)-1);
 const saved=selection.attempt===schedule.attempt_id;
 const selected=saved&&selection.day>=first&&selection.day<=final?selection.day:first;
 const items=schedule.preview?.placements.filter(p=>date(p.start_at)===selected).sort((a,b)=>a.start_at-b.start_at)??[];
 return <View style={{gap:24}}>
  <View style={{gap:8}}><AppText style={{fontSize:28,lineHeight:36,fontWeight:'700'}}>你的行动日历</AppText><Caption>{first} — {final} · {schedule.period?Math.round((schedule.period.end_at-schedule.period.start_at)/(7*86400000)):1}周</Caption><Caption>{schedule.timezone==='UTC'?'UTC':'北京时间'} · {approved?'已确认安排':'候选时间'}</Caption><Caption>{approved?'已确认并加入你的日历。':remaining?'按你补充的偏好拟定未来安排，确认前原日历不变。':schedule.window_basis==='agent_proposal_v1'?'按当前草稿的时间建议拟定，仍可继续调整。':schedule.window_basis?'暂按北京时间每天20:00–21:00安排。可继续补充没空的时间。':'按已核对时段安排。'}{!approved&&!remaining&&'确认前尚未入历。'}</Caption>{schedule.period_basis==='assumed_one_week_per_stage_v1'&&<Caption>阶段周期暂按各一周，可继续问答调整。</Caption>}</View>
  <CalendarMonth key={schedule.attempt_id+'_'+schedule.review_revision} first={first} last={final} selected={selected} marked={new Set(schedule.preview?.placements.map(p=>date(p.start_at)))} onSelect={day=>setSelection({attempt:schedule.attempt_id,month:day.slice(0,7),day})}/>
  <View style={{gap:16}}><View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center'}}><AppText accessibilityRole="header" style={{fontSize:19,fontWeight:'600'}}>{Number(selected.slice(5,7))}月{Number(selected.slice(8))}日</AppText><Caption>{items.length}项安排</Caption></View>
   {items.map(p=>{const task=schedule.tasks.find(t=>t.id===p.task_id)!;const start=scheduleTime(p.start_at,schedule.timezone).split(' ').at(-1),end=scheduleTime(p.end_at,schedule.timezone).split(' ').at(-1);return <Card key={p.task_id} style={{padding:20}}><View style={{flexDirection:'row',gap:14}}><View style={{width:3,borderRadius:2,backgroundColor:colors.text}}/><View style={{flex:1,gap:10}}><Caption>{start} — {end}{task.stage?` · 阶段${task.stage}`:''}</Caption><AppText style={{fontSize:20,lineHeight:27,fontWeight:'600'}}>{task.title}</AppText><AppText>{instructions(task.series_id??task.id)}</AppText><Caption>{task.duration_minutes}分钟 · {approved?'已确认':'建议安排'}</Caption></View></View></Card>;})}
   {!items.length&&<View style={{paddingVertical:24,gap:8}}><AppText>这天留白</AppText><Caption>没有安排任务，可以休息或补充你的时间偏好。</Caption></View>}
  </View>
  {!!schedule.preview?.unplaced.length&&<Card><AppText>{schedule.preview.unplaced.length}次任务需要调整</AppText><Caption>现有时段放不下全部任务。可以继续告诉 Guidy 你的时间偏好，再核对方案。</Caption></Card>}
 </View>;
}
