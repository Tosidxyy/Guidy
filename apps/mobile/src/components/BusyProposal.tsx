import {Action,Badge,Caption,Card} from './ui';
import {CONFIRM_BUSY,type BusyProposal as Proposal} from '../goals/calendar';
import {scheduleTime} from '../goals/schedule';
export function BusyProposal({proposal,saved,confirmable,stale,onConfirm}:{proposal:Proposal;saved:boolean;confirmable:boolean;stale:boolean;onConfirm:(text:string)=>void}){
 return <Card><Badge>{saved?'已有占用 · 已保存':'已有占用 · 待核对'}</Badge>
 {proposal.events.map(e=><Caption key={e.id}>{scheduleTime(e.start_at,e.timezone)} — {scheduleTime(e.end_at,e.timezone)} · {e.timezone==='UTC'?'UTC':'北京时间'}</Caption>)}
 {saved?<Caption>保存于日历版本 {proposal.calendar_revision}，所有目标试排会避开这些已确认占用；没有创建目标任务或提醒。</Caption>:<><Caption>确认后将保存到账号日历；不移动已有事件。</Caption>{stale&&<Caption>日历已改变或时段过期，请重新提供并核对。</Caption>}<Action label="确认保存已有占用" disabled={!confirmable||stale} onPress={()=>onConfirm(CONFIRM_BUSY)}/></>}
 </Card>;
}
