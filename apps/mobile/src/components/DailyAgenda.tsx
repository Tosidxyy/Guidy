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
 {blocks.map(b=><Card key={b.id} style={{padding:18,borderWidth:0}}><View style={{flexDirection:'row',gap:14}}><View style={{width:1,borderRadius:2,backgroundColor:colors.text}}/><View style={{flex:1,gap:10}}><AppText style={{fontSize:14,color:colors.secondary}}>{clockTime(b.start_at,timezone)} — {clockTime(b.end_at,timezone)}</AppText>{b.title!==b.taskTitle&&<Caption>{b.taskTitle}</Caption>}<AppText style={{fontSize:18,lineHeight:26,fontWeight:'500'}}>{b.title}</AppText>{!!b.instructions&&<AppText>{b.instructions}</AppText>}{b.last&&b.goalId&&onOpen&&<Pressable accessibilityRole="button" accessibilityLabel={`查看${b.taskTitle}的方案`} onPress={()=>onOpen(b.goalId!)} style={{minHeight:44,justifyContent:'center'}}><AppText>回到方案聊聊 ›</AppText></Pressable>}</View></View></Card>)}
 {!blocks.length&&<Card><AppText>这一天，留给你安排</AppText><Caption>可以添加一件小事，也可以和 Guidy 一起规划。</Caption></Card>}
 </View>;
}
