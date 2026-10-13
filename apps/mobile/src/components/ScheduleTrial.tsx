import {Action,AppText,Badge,Caption,Card} from './ui';
import {CONFIRM_SCHEDULE,CONFIRM_WEEK,scheduleTime,type ScheduleData} from '../goals/schedule';
export function ScheduleTrial({schedule,stale,confirmable,onConfirm}:{schedule:ScheduleData;stale:boolean;confirmable:boolean;onConfirm:(text:string)=>void}){
 const preview=schedule.preview,weekly=schedule.scope==='first_stage_week_v1';
 const title=(id:string)=>{const t=schedule.tasks.find(t=>t.id===id);return t?.title+(weekly?` · 第${t?.ordinal}/${t?.repeat_count}次`:'');};
 return <Card>
  <Badge>{preview?weekly?'首阶段一周 · 拟安排':'首阶段各项一次 · 拟安排':'可用时段 · 待核对'}</Badge>
  {weekly&&<Caption>首阶段一周 · 按草稿频次共{schedule.tasks.length}次 · 同项每天最多一次。{preview?`已排${preview.placements.length}次，未排${preview.unplaced.length}次。`:''}前置项本周试排实例全部排完后再排后续项。</Caption>}
  {schedule.period&&<Caption>周期：{scheduleTime(schedule.period.start_at,schedule.timezone)} 至 {scheduleTime(schedule.period.end_at,schedule.timezone)}（结束不含）</Caption>}
  <Caption>时区：{schedule.timezone==='Asia/Shanghai'?'北京时间（Asia/Shanghai）':'UTC'}</Caption>
  {schedule.calendar_snapshot&&<Caption>已核对账号日历版本 {schedule.calendar_snapshot.revision} · 本周期 {schedule.calendar_snapshot.busy.length} 项已确认占用。未记录不代表没有其他日程。</Caption>}
  {schedule.windows.map(w=><Caption key={w.start_at}>{scheduleTime(w.start_at,schedule.timezone)} — {scheduleTime(w.end_at,schedule.timezone)}</Caption>)}
  {stale&&<Caption>方案或时段已改变/过期，此记录只供参考，请重新提供时段。</Caption>}
  {preview?<>
   {preview.placements.map(p=><Card key={p.task_id}><AppText>{title(p.task_id)}</AppText><Caption>{scheduleTime(p.start_at,schedule.timezone)} — {scheduleTime(p.end_at,schedule.timezone)}</Caption></Card>)}
   {preview.unplaced.map(p=><Caption key={p.task_id}>未安排：{title(p.task_id)} · {p.reason==='dependency_unplaced'?'前置任务尚未安排':'当前试排未找到能容纳完整任务的时间窗'}</Caption>)}
   <Caption>没有批准或写入目标任务。{schedule.calendar_snapshot?'已避开账号已确认的占用，其他日程与领域约束仍待核对':'旧预览未检查日历占用'}；{weekly?'后续阶段和领域休息要求仍待核对':'不是完整周计划'}，不保证最优。确认方案入历仍在开发。</Caption>
  </>:<><Caption>{weekly?'确认声明的一周时段与草稿频次，每项每天最多一次；尚未核实领域所需休息间隔，不批准入历。':'确认的是你声明的可用时段，只试排首阶段每项一次；不展开周频次，不批准入历。'}</Caption><Action label="确认时段并预览" disabled={!confirmable||stale} onPress={()=>onConfirm(weekly?CONFIRM_WEEK:CONFIRM_SCHEDULE)}/></>}
 </Card>;
}
