import {useState} from 'react';
import {Pressable,ScrollView,View} from 'react-native';
import {AppText,Caption} from './ui';
import {useTheme} from '../theme/ThemeProvider';

export function CalendarMonth({first,last,selected,marked,onSelect}:{first:string;last:string;selected:string;marked:Set<string>;onSelect:(day:string)=>void}){
 const {colors}=useTheme();const [stored,setMonth]=useState(selected.slice(0,7)),[width,setWidth]=useState(308);
 const month=stored>=first.slice(0,7)&&stored<=last.slice(0,7)?stored:first.slice(0,7);
 const [year,number]=month.split('-').map(Number),leading=(new Date(Date.UTC(year,number-1,1)).getUTCDay()+6)%7,count=new Date(Date.UTC(year,number,0)).getUTCDate();
 const cells=Array.from({length:Math.ceil((leading+count)/7)*7},(_,i)=>i-leading+1);
 function move(delta:number){const target=new Date(Date.UTC(year,number-1+delta,1)).toISOString().slice(0,7);if(target<first.slice(0,7)||target>last.slice(0,7))return;setMonth(target);onSelect(target===first.slice(0,7)?first:target+'-01');}
 const control=(delta:number,label:string,disabled:boolean)=><Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled}} disabled={disabled} onPress={()=>move(delta)} style={{width:44,height:44,justifyContent:'center',alignItems:'center',opacity:disabled?0.25:1}}><AppText style={{fontSize:24}}>{delta<0?'‹':'›'}</AppText></Pressable>;
 return <View onLayout={event=>{const value=Math.floor(event.nativeEvent.layout.width);if(value>0)setWidth(value);}} style={{borderBottomWidth:1,borderBottomColor:colors.divider,paddingBottom:16,gap:12}}>
  <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between'}}><AppText accessibilityRole="header" style={{fontSize:22,fontWeight:'600'}}>{year}年{number}月</AppText><View style={{flexDirection:'row'}}>{control(-1,'上个月',month===first.slice(0,7))}{control(1,'下个月',month===last.slice(0,7))}</View></View>
  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{width:'100%'}}><View style={{width:Math.max(308,width)}}>
   <View style={{flexDirection:'row'}}>{['一','二','三','四','五','六','日'].map(day=><View key={day} style={{flex:1,height:32,alignItems:'center',justifyContent:'center'}}><Caption>{day}</Caption></View>)}</View>
   <View style={{flexDirection:'row',flexWrap:'wrap'}}>{cells.map((n,i)=>{
    const value=month+'-'+String(n).padStart(2,'0'),inside=n>=1&&n<=count,enabled=inside&&value>=first&&value<=last;
    return <View key={i} style={{width:'14.285714%',minHeight:52,alignItems:'center'}}>{inside&&<Pressable accessibilityRole="button" accessibilityLabel={`查看${value}`} accessibilityState={{selected:value===selected,disabled:!enabled}} disabled={!enabled} onPress={()=>onSelect(value)} style={{width:44,minHeight:52,alignItems:'center',justifyContent:'center',gap:4,opacity:enabled?1:0.3}}><View style={{width:36,height:36,borderRadius:18,alignItems:'center',justifyContent:'center',backgroundColor:value===selected?colors.action:'transparent'}}><AppText style={{fontSize:16,fontWeight:value===selected?'600':'400',color:value===selected?colors.onAction:colors.text}}>{n}</AppText></View><View style={{width:4,height:4,borderRadius:2,backgroundColor:marked.has(value)?colors.text:'transparent'}}/></Pressable>}</View>;
   })}</View>
  </View></ScrollView>
 </View>;
}
