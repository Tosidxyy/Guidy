import {Platform,View,type ColorValue} from 'react-native';
import {SymbolView} from 'expo-symbols';

type Name='goals'|'calendar'|'me';
const symbols={goals:{ios:'target',android:'target',web:'target'},calendar:{ios:'calendar',android:'calendar_month',web:'calendar_month'},me:{ios:'person',android:'person',web:'person'}} as const;

export function TabIcon({name,color}:{name:Name;color:ColorValue}){
 if(Platform.OS!=='web')return <SymbolView name={symbols[name]} tintColor={color} size={24}/>;
 // Preview icons use geometry so they work without downloading a symbol font.
 return <View accessible={false} aria-hidden style={{width:24,height:24,alignItems:'center',justifyContent:'center'}}>
  {name==='goals'?<><View style={{width:21,height:21,borderRadius:11,borderWidth:1.6,borderColor:color,alignItems:'center',justifyContent:'center'}}><View style={{width:12,height:12,borderRadius:6,borderWidth:1.6,borderColor:color,alignItems:'center',justifyContent:'center'}}><View style={{width:3,height:3,borderRadius:2,backgroundColor:color}}/></View></View></>:name==='calendar'?<View style={{width:20,height:20,borderWidth:1.6,borderColor:color,borderRadius:3,paddingTop:5}}><View style={{height:1.6,backgroundColor:color}}/><View style={{position:'absolute',top:-3,left:4,width:1.6,height:6,backgroundColor:color}}/><View style={{position:'absolute',top:-3,right:4,width:1.6,height:6,backgroundColor:color}}/><View style={{margin:4,width:4,height:4,borderRadius:1,backgroundColor:color}}/></View>:<><View style={{width:8,height:8,borderWidth:1.6,borderColor:color,borderRadius:4,marginBottom:3}}/><View style={{width:18,height:9,borderWidth:1.6,borderColor:color,borderTopLeftRadius:9,borderTopRightRadius:9,borderBottomLeftRadius:2,borderBottomRightRadius:2}}/></>}
 </View>;
}
