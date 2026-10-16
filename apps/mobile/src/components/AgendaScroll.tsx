import {createContext,useCallback,useContext,useRef,type PropsWithChildren} from 'react';
import {ScrollView,View,type ScrollViewProps} from 'react-native';
const Reveal=createContext<(view:View)=>void>(()=>{});
export const useAgendaReveal=()=>useContext(Reveal);
export function AgendaScroll({children,...props}:PropsWithChildren<ScrollViewProps>){
 const viewport=useRef<View>(null),scroll=useRef<ScrollView>(null),offset=useRef(0);
 const reveal=useCallback((view:View)=>{requestAnimationFrame(()=>{viewport.current?.measure((_x,_y,_w,_h,_px,top)=>view.measure((_a,_b,_c,_d,_e,target)=>scroll.current?.scrollTo({y:Math.max(0,offset.current+target-top-12),animated:true})));});},[]);
 return <Reveal.Provider value={reveal}><View ref={viewport} collapsable={false} style={{flex:1}}><ScrollView style={{flex:1}} {...props} ref={scroll} onScroll={e=>{offset.current=e.nativeEvent.contentOffset.y;props.onScroll?.(e);}} scrollEventThrottle={16}>{children}</ScrollView></View></Reveal.Provider>;
}
