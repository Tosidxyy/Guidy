export const ASK_BUSY='请帮我记录已有占用。';
export const CONFIRM_BUSY='确认保存这些已有占用。';
export function isBusyText(text:string){return text===ASK_BUSY||text===CONFIRM_BUSY||/^已有占用[：:]/.test(text);}
export type BusyEvent={id:string;title:string;start_at:number;end_at:number;timezone:'UTC'|'Asia/Shanghai';fixed:1;source:'user'};
export type BusyProposal={calendar_revision:number;timezone:'UTC'|'Asia/Shanghai';events:BusyEvent[];confirmed_from_run_id?:string};
export type CalendarSnapshot={schema_version:1;from:number;to:number;revision:number;events:BusyEvent[]};
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f-]{36}$/.test(v);
export function validBusy(e:BusyEvent){return !!e&&uuid(e.id)&&typeof e.title==='string'&&!!e.title.trim()&&e.title.length<=80&&Number.isSafeInteger(e.start_at)&&e.start_at>=0&&Number.isSafeInteger(e.end_at)&&e.end_at>e.start_at&&e.end_at<=8640000000000000&&['UTC','Asia/Shanghai'].includes(e.timezone)&&e.fixed===1&&e.source==='user';}
export function checkedBusy(b:BusyProposal|undefined,stage:string){if(!b||!Number.isSafeInteger(b.calendar_revision)||b.calendar_revision<0||!['UTC','Asia/Shanghai'].includes(b.timezone)||!Array.isArray(b.events)||!b.events.length||b.events.length>7||!b.events.every(e=>validBusy(e)&&e.timezone===b.timezone)||new Set(b.events.map(e=>e.id)).size!==b.events.length||(stage==='busy_saved'?!uuid(b.confirmed_from_run_id)||b.calendar_revision<1:b.confirmed_from_run_id!==undefined))throw new Error('已有占用格式不正确。');}
export function checkedCalendar(v:CalendarSnapshot,from:number,to:number){if(!v||v.schema_version!==1||v.from!==from||v.to!==to||!Number.isSafeInteger(v.revision)||v.revision<0||!Array.isArray(v.events)||v.events.length>500||!v.events.every(e=>validBusy(e)&&e.start_at<to&&e.end_at>from)||new Set(v.events.map(e=>e.id)).size!==v.events.length)throw new Error('日历响应格式不正确。');return v;}
