import {useCallback,useRef,useState} from 'react';
import {useFocusEffect} from 'expo-router';
import {Action,AppText,Badge,Caption,Card,Screen,SectionTitle} from '../../src/components/ui';
import {useAccount} from '../../src/auth/AuthProvider';
import {getCalendar} from '../../src/goals/api';
import type {CalendarSnapshot} from '../../src/goals/calendar';
import {scheduleTime} from '../../src/goals/schedule';
export default function CalendarScreen(){const {user}=useAccount();return <CalendarBody key={user?.id??'anonymous'} owner={user?.id}/>;}
function CalendarBody({owner}:{owner?:string}){
 const [data,setData]=useState<CalendarSnapshot|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0);const generation=useRef(0);
 useFocusEffect(useCallback(()=>{void refresh;const scope=++generation.current,c=new AbortController();setData(null);setError('');if(owner){setLoading(true);const from=Date.now()-86400000,to=from+31*86400000;getCalendar(from,to,c.signal).then(v=>{if(!c.signal.aborted&&generation.current===scope)setData(v);}).catch(e=>{if(!c.signal.aborted&&generation.current===scope)setError(e instanceof Error?e.message:'日历读取失败。');}).finally(()=>{if(generation.current===scope)setLoading(false);});}return()=>{c.abort();generation.current++;};},[owner,refresh]));
 return <Screen title="日历"><SectionTitle>近期已有占用</SectionTitle><Caption>显示过去24小时至未来30天内，用户已确认的账号日历占用。尚未接入目标任务入历或系统日历读取。</Caption>
 {!owner&&<Caption>请先到「我的」登录，再查看已保存日程。</Caption>}
 {owner&&<Action label="重新读取日历" secondary disabled={loading} onPress={()=>setRefresh(n=>n+1)}/>}
 {loading&&<Caption>正在读取…</Caption>}{!!error&&<AppText accessibilityRole="alert">{error}</AppText>}
 {data&&<><Caption>日历版本 {data.revision} · {data.events.length} 项已有占用</Caption>{!data.events.length&&<Card><AppText>近期没有已保存的占用</AppText><Caption>可在目标聊天中点击「记录已有占用」，提供具体日期和时间，核对后保存。</Caption></Card>}{data.events.map(e=><Card key={e.id}><Badge>固定占用 · 不自动移动</Badge><AppText>{e.title}</AppText><Caption>{scheduleTime(e.start_at,e.timezone)} — {scheduleTime(e.end_at,e.timezone)}</Caption><Caption>时区：{e.timezone==='UTC'?'UTC':'北京时间（Asia/Shanghai）'}</Caption></Card>)}</>}
 </Screen>;
}