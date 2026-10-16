import {useCallback,useRef,useState} from 'react';
import {router,useFocusEffect} from 'expo-router';
import {Action,AppText,Caption,Card,Screen} from '../../src/components/ui';
import {CalendarMonth} from '../../src/components/CalendarMonth';
import {useAccount} from '../../src/auth/AuthProvider';
import {getUpcomingCalendar} from '../../src/goals/api';
import type {UpcomingCalendar} from '../../src/goals/approval';
import {DailyAgenda} from '../../src/components/DailyAgenda';
import {dailyBlocks} from '../../src/goals/daily-agenda';
export default function CalendarScreen(){const {user}=useAccount();return <CalendarBody key={user?.id??'anonymous'} owner={user?.id}/>;}
function CalendarBody({owner}:{owner?:string}){
 const [reveal,setReveal]=useState(0);
 const date=(at:number)=>new Date(at+8*3600000).toISOString().slice(0,10);
 const [selected,setSelected]=useState(()=>date(Date.now())),[data,setData]=useState<UpcomingCalendar|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0);const generation=useRef(0);
 const month=selected.slice(0,7);
 useFocusEffect(useCallback(()=>{
  void refresh;const scope=++generation.current,c=new AbortController();setData(null);setError('');
  if(owner){setLoading(true);const [year,number]=month.split('-').map(Number),from=Date.UTC(year,number-1,1)-8*3600000,to=Date.UTC(year,number,1)-8*3600000;
   getUpcomingCalendar(from,to,c.signal).then(v=>{if(!c.signal.aborted&&generation.current===scope)setData(v);}).catch(e=>{if(!c.signal.aborted&&generation.current===scope)setError(e instanceof Error?e.message:'日历读取失败。');}).finally(()=>{if(generation.current===scope)setLoading(false);});
  }
  return()=>{c.abort();generation.current++;};
 },[owner,refresh,month]));
 const active=data?.events.filter(e=>e.source==='user'||e.status==='scheduled')??[];
 const blocks=active.filter(e=>date(e.start_at)===selected).flatMap(e=>dailyBlocks({...e,goalId:e.goal_id??undefined}));
 return <Screen title="日历"><Caption>北京时间 · 确认后的行动安排</Caption>
  {!owner?<Card><AppText>把计划变成每天的行动</AppText><Caption>登录并确认一份方案后，安排会出现在这里。</Caption><Action label="去登录" onPress={()=>router.push('/(tabs)/me')}/></Card>:<>
   <CalendarMonth first="1900-01-01" last="2100-12-31" selected={selected} marked={new Set(active.map(e=>date(e.start_at)))} onSelect={day=>{setSelected(day);setReveal(n=>n+1);}}/>
   {loading&&<Caption>正在同步日历…</Caption>}
   {!!error&&<Card><AppText accessibilityRole="alert">{error}</AppText><Action label="重新读取" secondary onPress={()=>setRefresh(n=>n+1)}/></Card>}
   {data&&<DailyAgenda day={selected} blocks={blocks} timezone="Asia/Shanghai" revealKey={reveal} onOpen={goalId=>router.push({pathname:'/goal/[id]/chat',params:{id:goalId}})}/>}
  </>}
 </Screen>;
}
