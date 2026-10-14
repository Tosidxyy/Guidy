import {useCallback,useRef,useState} from 'react';
import {router,useFocusEffect} from 'expo-router';
import {Pressable,View} from 'react-native';
import {Action,AppText,Caption,Card,Screen} from '../../src/components/ui';
import {CalendarMonth} from '../../src/components/CalendarMonth';
import {useAccount} from '../../src/auth/AuthProvider';
import {getUpcomingCalendar} from '../../src/goals/api';
import type {UpcomingCalendar} from '../../src/goals/approval';
import {useTheme} from '../../src/theme/ThemeProvider';
import {scheduleTime} from '../../src/goals/schedule';
export default function CalendarScreen(){const {user}=useAccount();return <CalendarBody key={user?.id??'anonymous'} owner={user?.id}/>;}
function CalendarBody({owner}:{owner?:string}){
 const {colors}=useTheme();
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
 const events=data?.events.filter(e=>date(e.start_at)===selected)??[];
 return <Screen title="日历"><Caption>北京时间 · 确认后的行动安排</Caption>
  {!owner?<Card><AppText>把计划变成每天的行动</AppText><Caption>登录并确认一份方案后，安排会出现在这里。</Caption><Action label="去登录" onPress={()=>router.push('/(tabs)/me')}/></Card>:<>
   <CalendarMonth first="1900-01-01" last="2100-12-31" selected={selected} marked={new Set(data?.events.map(e=>date(e.start_at)))} onSelect={setSelected}/>
   {loading&&<Caption>正在同步日历…</Caption>}
   {!!error&&<Card><AppText accessibilityRole="alert">{error}</AppText><Action label="重新读取" secondary onPress={()=>setRefresh(n=>n+1)}/></Card>}
   {data&&<View style={{gap:16}}><View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center'}}><AppText accessibilityRole="header" style={{fontSize:20,fontWeight:'600'}}>{Number(selected.slice(5,7))}月{Number(selected.slice(8))}日</AppText><Caption>{events.length}项安排</Caption></View>
    {!events.length&&<Card><AppText>这天留白</AppText><Caption>确认的计划会自动排入日历，也可以在目标中查看完整方案。</Caption></Card>}
    {events.map(e=><Card key={e.id} style={{padding:20}}><View style={{flexDirection:'row',gap:14}}><View style={{width:3,borderRadius:2,backgroundColor:e.source==='plan'?colors.text:colors.secondary}}/><View style={{flex:1,gap:10}}><Caption>{scheduleTime(e.start_at,'Asia/Shanghai').split(' ').at(-1)} — {scheduleTime(e.end_at,'Asia/Shanghai').split(' ').at(-1)}</Caption><AppText style={{fontSize:20,fontWeight:'600'}}>{e.title}</AppText>{e.source==='plan'?<><AppText>{e.instructions}</AppText><Caption>已确认 · 尚未记录完成</Caption><Pressable accessibilityRole="button" accessibilityLabel={`查看${e.title}的方案`} onPress={()=>router.push({pathname:'/goal/[id]/chat',params:{id:e.goal_id!}})} style={{minHeight:44,justifyContent:'center'}}><AppText>查看方案 →</AppText></Pressable></>:<Caption>固定事项 · 不自动移动</Caption>}</View></View></Card>)}
   </View>}
  </>}
 </Screen>;
}
