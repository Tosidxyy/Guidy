import {Action,AppText,Badge,Caption,Card} from './ui';
import {CONFIRM_SCHEDULE,scheduleTime,type ScheduleData} from '../goals/schedule';
export function ScheduleTrial({schedule,stale,confirmable,onConfirm}:{schedule:ScheduleData;stale:boolean;confirmable:boolean;onConfirm:(text:string)=>void}){
 const preview=schedule.preview;
 return <Card>
  <Badge>{preview?'首阶段各项一次 · 拟安排':'可用时段 · 待核对'}</Badge>
  <Caption>时区：{schedule.timezone==='Asia/Shanghai'?'北京时间（Asia/Shanghai）':'UTC'}</Caption>
  {schedule.windows.map(w=><Caption key={w.start_at}>{scheduleTime(w.start_at,schedule.timezone)} — {scheduleTime(w.end_at,schedule.timezone)}</Caption>)}
  {stale&&<Caption>方案或时段已改变/过期，此记录只供参考，请重新提供时段。</Caption>}
  {preview?<>
   {preview.placements.map(p=><Card key={p.task_id}><AppText>{schedule.tasks.find(t=>t.id===p.task_id)?.title}</AppText><Caption>{scheduleTime(p.start_at,schedule.timezone)} — {scheduleTime(p.end_at,schedule.timezone)}</Caption></Card>)}
   {preview.unplaced.map(p=><Caption key={p.task_id}>未安排：{schedule.tasks.find(t=>t.id===p.task_id)?.title} · {p.reason==='dependency_unplaced'?'前置任务尚未安排':'当前试排未找到能容纳完整任务的时间窗'}</Caption>)}
   <Caption>没有写入日历。尚未检查真实日历占用和完整领域约束；不是完整周计划，不保证最优。确认方案入历仍在开发。</Caption>
  </>:<><Caption>确认的是你声明的可用时段，只试排首阶段每项一次；不展开周频次，不批准入历。</Caption><Action label="确认时段并预览" disabled={!confirmable||stale} onPress={()=>onConfirm(CONFIRM_SCHEDULE)}/></>}
 </Card>;
}
