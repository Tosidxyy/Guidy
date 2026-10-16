import {useEffect,useRef} from 'react';
import {View,Pressable} from 'react-native';
import {AppText,Caption,Card} from './ui';
import {useTheme} from '../theme/ThemeProvider';
import {clockTime,type DailyBlock} from '../goals/daily-agenda';
import {useAgendaReveal} from './AgendaScroll';
export function DailyAgenda({day,blocks,timezone,revealKey,onOpen}:{day:string;blocks:DailyBlock[];timezone:string;revealKey:number;onOpen?:(goalId:string)=>void}){
 const {colors}=useTheme(),ref=useRef<View>(null),reveal=useAgendaReveal();
 useEffect(()=>{if(revealKey&&ref.current)reveal(ref.current);},[day,revealKey,reveal]);
 return <View ref={ref} collapsable={false} style={{gap:16}}><View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center'}}><AppText accessibilityRole="header" style={{fontSize:20,fontWeight:'600'}}>{Number(day.slice(5,7))}月{Number(day.slice(8))}日</AppText><Caption>{blocks.length}个时间段</Caption></View>
 {blocks.map(b=><Card key={b.id} style={{padding:20}}><View style={{flexDirection:'row',gap:14}}><View style={{width:3,borderRadius:2,backgroundColor:colors.text}}/><View style={{flex:1,gap:10}}><AppText style={{fontSize:19,fontWeight:'700'}}>{clockTime(b.start_at,timezone)} — {clockTime(b.end_at,timezone)}</AppText>{b.title!==b.taskTitle&&<Caption>{b.taskTitle}</Caption>}<AppText style={{fontSize:20,lineHeight:27,fontWeight:'600'}}>{b.title}</AppText>{!!b.instructions&&<AppText>{b.instructions}</AppText>}{b.last&&b.goalId&&onOpen&&<Pressable accessibilityRole="button" accessibilityLabel={`查看${b.taskTitle}的方案`} onPress={()=>onOpen(b.goalId!)} style={{minHeight:44,justifyContent:'center'}}><AppText>查看方案 →</AppText></Pressable>}</View></View></Card>)}
 {!blocks.length&&<Card><AppText>这天没有激活的时间段</AppText><Caption>仅显示实际安排，不展示空白或已失效的时段。</Caption></Card>}
 </View>;
}
