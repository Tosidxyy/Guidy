import {CalendarMonth} from './CalendarMonth';
import {useState,useEffect} from 'react';
import {View} from 'react-native';
import {AppText,Caption,Card,Action} from './ui';
import {DailyAgenda} from './DailyAgenda';
import {dailyBlocks} from '../goals/daily-agenda';
import {getUpcomingCalendar} from '../goals/api';
import type {UpcomingCalendar} from '../goals/approval';
import type {PlanSegment} from '../goals/plans';
import type {ScheduleData} from '../goals/schedule';
export function PlanCalendar({schedule,instructions,segments,approved=false,planVersionId}:{approved?:boolean;planVersionId?:string;schedule:ScheduleData;instructions:(id:string)=>string|undefined;segments?:(id:string)=>PlanSegment[]|undefined}){
 const [selection,setSelection]=useState({attempt:'',day:''}),[reveal,setReveal]=useState(0),[snapshot,setSnapshot]=useState<{key:string;data?:UpcomingCalendar;error?:string}|null>(null),[retry,setRetry]=useState(0);
 const offset=schedule.timezone==='UTC'?0:28800000,date=(at:number)=>new Date(at+offset).toISOString().slice(0,10);
 const first=date(Math.min(...(schedule.preview?.placements.length?schedule.preview.placements.map(p=>p.start_at):[schedule.period?.start_at??schedule.windows[0].start_at]))),last=date((schedule.period?.end_at??schedule.windows.at(-1)!.end_at)-1);
 const selected=selection.attempt===schedule.attempt_id&&selection.day>=first&&selection.day<=last?selection.day:first,month=selected.slice(0,7);
 const requestKey=String(planVersionId)+month+offset+retry,live=snapshot?.key===requestKey?snapshot.data:null,error=snapshot?.key===requestKey?snapshot.error:undefined;
 useEffect(()=>{if(!approved||!planVersionId)return;const c=new AbortController(),[y,m]=month.split('-').map(Number);void getUpcomingCalendar(Date.UTC(y,m-1,1)-offset,Date.UTC(y,m,1)-offset,c.signal).then(v=>{if(!c.signal.aborted)setSnapshot({key:requestKey,data:v});}).catch(e=>{if(!c.signal.aborted)setSnapshot({key:requestKey,error:e instanceof Error?e.message:'读取当天安排失败。'});});return()=>c.abort();},[approved,planVersionId,month,offset,requestKey]);
 const active=live?.events.filter(e=>e.source==='plan'&&e.plan_version_id===planVersionId&&e.status==='scheduled')??[];
 const placements=schedule.preview?.placements??[];
 const blocks=approved?active.filter(e=>date(e.start_at)===selected).flatMap(e=>dailyBlocks(e)):placements.filter(p=>date(p.start_at)===selected).flatMap(p=>{const t=schedule.tasks.find(t=>t.id===p.task_id)!;return dailyBlocks({id:p.task_id,title:t.title,instructions:instructions(t.series_id??t.id)??'',segments:segments?.(t.series_id??t.id),start_at:p.start_at,end_at:p.end_at});});blocks.sort((a,b)=>a.start_at-b.start_at);
 return <View style={{gap:24}}><View style={{gap:8}}><AppText style={{fontSize:28,lineHeight:36,fontWeight:'700'}}>你的行动日历</AppText><Caption>{first} — {last}</Caption><Caption>{schedule.timezone==='UTC'?'UTC':'北京时间'} · {approved?'已确认安排':'候选时间'}</Caption><Caption>{approved?'已确认并加入你的日历。':'以下是待确认的时间建议，确认前不会加入日历。'}</Caption></View>
 <CalendarMonth first={first} last={last} selected={selected} marked={new Set((approved?active:placements).map(p=>date(p.start_at)))} onSelect={day=>{setSelection({attempt:schedule.attempt_id,day});setReveal(n=>n+1);}}/>
 {approved&&!live&&!error&&<Caption>正在读取激活的时间段…</Caption>}{!!error&&<Card><AppText accessibilityRole="alert">{error}</AppText><Action label="重新读取当天安排" secondary onPress={()=>setRetry(n=>n+1)}/></Card>}
 {(!approved||!!live)&&<DailyAgenda day={selected} blocks={blocks} timezone={schedule.timezone} revealKey={reveal}/>}
 {!!schedule.preview?.unplaced.length&&<Card><AppText>{schedule.preview.unplaced.length}次任务需要调整</AppText><Caption>告诉 Guidy 你的偏好，再核对新的时间建议。</Caption></Card>}
 </View>;
}
