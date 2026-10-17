import {View} from 'react-native';
import {AppText,Caption} from './ui';
import {useTheme} from '../theme/ThemeProvider';
import type {PlanDraft} from '../goals/plans';
export function StrategyOverview({draft}:{draft:PlanDraft}){
 const {colors}=useTheme();
 const phases=draft.stage_weeks??[...new Set(draft.tasks.map(t=>t.stage))].map(stage=>({stage,weeks:1}));
 const days=phases.reduce((n,p)=>n+p.weeks*7,0);
 return <View style={{gap:28}}><View style={{gap:12}}><Caption>{days}天 · 你的行动策略</Caption><AppText style={{fontSize:27,lineHeight:36,fontWeight:'600'}}>{draft.title}</AppText><AppText style={{lineHeight:26,color:colors.secondary}}>{draft.summary}</AppText></View>
 {phases.map((p,index)=>{const from=1+phases.slice(0,index).reduce((n,phase)=>n+phase.weeks*7,0);const end=from+p.weeks*7-1;const tasks=draft.tasks.filter(t=>t.stage===p.stage);return <View key={p.stage} style={{flexDirection:'row',gap:16}}><View style={{alignItems:'center',width:32,gap:8}}><View style={{width:32,height:32,borderRadius:16,backgroundColor:colors.divider,alignItems:'center',justifyContent:'center'}}><AppText>{p.stage}</AppText></View><View style={{width:1,flex:1,backgroundColor:colors.divider}}/></View><View style={{flex:1,gap:12,paddingBottom:12}}><Caption>第 {from} — {end} 天</Caption>{tasks.map(t=><View key={t.id} style={{gap:8}}><AppText style={{fontSize:18,fontWeight:'600',lineHeight:26}}>{t.title}</AppText><AppText style={{color:colors.secondary,lineHeight:25}}>{t.instructions}</AppText><Caption>每周 {t.frequency_per_week} 次 · 每次 {t.duration_minutes} 分钟</Caption></View>)}</View></View>;})}
 </View>;
}
