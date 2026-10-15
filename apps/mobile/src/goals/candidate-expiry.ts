import type {ScheduleData} from './schedule';

export function planningDay(timezone:string,now=Date.now()) {
 return Math.floor((now+(timezone==='UTC'?0:28800000))/86400000);
}

/** Apply only to unconfirmed candidates; accepted calendars retain their history. */
export function candidateExpired(schedule:ScheduleData,now=Date.now()) {
 return !!schedule.preview?.placements.some(p=>p.start_at<=now)||
  !!schedule.preview?.unplaced.some(p=>schedule.tasks.some(t=>t.id===p.task_id&&t.deadline_at!==undefined&&t.deadline_at<=now))||
  !!(schedule.period&&schedule.period.end_at<=now);
}

export function candidateKeyCurrent(key:string,timezone:string,now=Date.now()) {
 const day=/^auto_schedule_[0-9a-f-]{36}_\d+_\d+_(\d+)$/.exec(key)?.[1];
 return day!==undefined&&Number(day)===planningDay(timezone,now);
}
