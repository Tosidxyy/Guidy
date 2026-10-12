import {useRef,useState} from 'react';
import {Action,AppText,Badge,Caption,Card} from './ui';
import {saveReview,GoalApiError} from '../goals/api';
import type {EditProposal} from '../goals/dialogue';
export function DraftEditProposal({id,runId,proposal,receipt,stale:serverStale,editable,onSaved}:{id:string;runId:string;proposal:EditProposal;receipt?:number|null;stale?:boolean;editable:boolean;onSaved:()=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[localStale,setStale]=useState(false),[declined,setDeclined]=useState(false),[localSaved,setSaved]=useState<number|null>(null);
 const saved=receipt??localSaved,stale=!!serverStale||localStale;
 const lock=useRef(false);
 async function apply(){if(lock.current||saved!==null||!editable||stale)return;lock.current=true;setBusy(true);setError('');try{const value=await saveReview(id,proposal.attempt_id,{expected_goal_revision:proposal.goal_revision,expected_review_revision:proposal.review_revision,proposal_run_id:runId,changes:[{task_id:proposal.task_id,...proposal.after}]},'chat_edit_'+runId);setSaved(value.receipt_revision!);onSaved();}catch(e){if(e instanceof GoalApiError&&['REVIEW_VERSION_CHANGED','REVIEW_SOURCE_CHANGED','REVIEW_CONTEXT_CHANGED'].includes(e.code??''))setStale(true);setError(e instanceof Error?e.message:'调整尚未保存，请读取状态。');}finally{lock.current=false;setBusy(false);}}
 return <Card><Badge>{saved!==null?'草稿调整已保存':declined?'原稿已保留':'草稿调整 · 待采用'}</Badge><AppText>{proposal.task_title}</AppText>
  <Caption>原来：每次 {proposal.before.duration_minutes} 分钟，每周 {proposal.before.frequency_per_week} 次</Caption>
  <Caption>建议：每次 {proposal.after.duration_minutes} 分钟，每周 {proposal.after.frequency_per_week} 次</Caption>
  <Caption>整体每周投入：{proposal.weekly_before} → {proposal.weekly_after} 分钟</Caption>
  <Caption>仅改时长和频次，步骤文字、依赖和引用保留，请核对是否一致。采用不代表批准方案或安排日历。</Caption>
  {!!error&&saved===null&&<AppText accessibilityRole="alert">{error}</AppText>}
  {saved!==null?<Caption>已保存审阅版本 {saved}，原稿保留。</Caption>:declined?<Caption>本次建议已收起，没有保存修改。</Caption>:<><Action label={busy?'正在保存调整…':'采用这次调整'} disabled={busy||!editable||stale} onPress={()=>{void apply();}}/><Action label="保留原稿" secondary disabled={busy} onPress={()=>setDeclined(true)}/></>}
  {stale&&saved===null&&<Caption>这条建议已过期，请基于最新草稿重新描述调整。</Caption>}
  {!editable&&saved===null&&<Caption>目标状态或版本已改变，这条建议目前不能采用。</Caption>}
 </Card>;
}
