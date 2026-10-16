import type {PlanSegment} from './plans';
export type DailyBlock={id:string;taskTitle:string;title:string;instructions:string;start_at:number;end_at:number;goalId?:string;last:boolean};
export function dailyBlocks(item:{id:string;title:string;instructions:string;start_at:number;end_at:number;segments?:PlanSegment[];goalId?:string}):DailyBlock[]{
 const segments=item.segments;
 const valid=segments&&segments.length>0&&segments.length<=3&&segments.every(s=>typeof s.title==='string'&&!!s.title.trim()&&typeof s.instructions==='string'&&!!s.instructions.trim()&&Number.isSafeInteger(s.duration_minutes)&&s.duration_minutes>0)&&segments.reduce((n,s)=>n+s.duration_minutes*60000,0)===item.end_at-item.start_at;
 let start=item.start_at;
 return (valid?segments:[{title:item.title,instructions:item.instructions,duration_minutes:(item.end_at-item.start_at)/60000}]).map((s,i,list)=>{const end=start+s.duration_minutes*60000,block={id:item.id+'_'+i,taskTitle:item.title,title:s.title,instructions:s.instructions,start_at:start,end_at:end,goalId:item.goalId,last:i===list.length-1};start=end;return block;});
}
export function clockTime(at:number,timezone:string){return new Intl.DateTimeFormat('zh-CN',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(at);}
