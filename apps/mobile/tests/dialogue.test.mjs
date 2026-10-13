import assert from 'node:assert/strict';
import test from 'node:test';
import { checkedDialogue, dialogueError, reviewSuggestions } from '../src/goals/dialogue.ts';
import {checkedBusy,checkedCalendar} from '../src/goals/calendar.ts';
test('confirmed account occupancy requires user provenance, valid ranges and an explicit receipt',()=>{
 const id='00000000-0000-0000-0000-000000000001',e={id,title:'已确认占用',start_at:1,end_at:60001,timezone:'UTC',fixed:1,source:'user'},b={calendar_revision:0,timezone:'UTC',events:[e]};
 checkedBusy(b,'busy_proposed');assert.throws(()=>checkedBusy(b,'busy_saved'));checkedBusy({...b,calendar_revision:1,confirmed_from_run_id:id},'busy_saved');
 assert.throws(()=>checkedBusy({...b,events:[{...e,source:'ai'}]},'busy_proposed'));assert.throws(()=>checkedBusy({...b,events:[{...e,end_at:1}]},'busy_proposed'));
 checkedCalendar({schema_version:1,from:0,to:100000,revision:1,events:[e]},0,100000);assert.throws(()=>checkedCalendar({schema_version:1,from:0,to:100000,revision:1,events:[e,e]},0,100000));
});
import {checkedSchedule,scheduleTime,isScheduleText,ASK_WEEK,CONFIRM_WEEK} from '../src/goals/schedule.ts';
test('weekly occurrence identities, counts and one-per-local-day cannot be forged',()=>{
 const id='00000000-0000-0000-0000-000000000001',start=Date.parse('2026-10-20T12:00:00Z');
 const tasks=Array.from({length:3},(_,i)=>({id:id+'_'+(i+1),series_id:id,ordinal:i+1,repeat_count:3,max_per_day:1,title:'练习',duration_minutes:20,depends_on:i?[id+'_'+i]:[]}));
 const s={attempt_id:id,goal_revision:0,review_revision:0,timezone:'Asia/Shanghai',scope:'first_stage_week_v1',period:{start_at:start-20*3600000,end_at:start-20*3600000+7*86400000},windows:Array.from({length:3},(_,i)=>({start_at:start+i*86400000,end_at:start+i*86400000+3600000})),tasks};
 checkedSchedule(s,'schedule_proposed');assert.equal(isScheduleText(ASK_WEEK),true);assert.equal(isScheduleText(CONFIRM_WEEK),true);
 const preview={...s,confirmed_from_run_id:id,preview:{schema_version:1,status:'preview_only',strategy:'stable_topological_earliest_v1',timezone:'Asia/Shanghai',placements:tasks.map((t,i)=>({task_id:t.id,start_at:start+i*86400000,end_at:start+i*86400000+1200000})),unplaced:[]}};
 checkedSchedule(preview,'schedule_preview');
 assert.throws(()=>checkedSchedule({...s,tasks:tasks.slice(0,2)},'schedule_proposed'));
 assert.throws(()=>checkedSchedule({...s,period:{...s.period,end_at:s.period.end_at-1}},'schedule_proposed'));
 assert.throws(()=>checkedSchedule({...preview,preview:{...preview.preview,placements:tasks.map((t,i)=>({task_id:t.id,start_at:start+i*1200000,end_at:start+(i+1)*1200000}))}},'schedule_preview'));
});
const base={goal:{id:'00000000-0000-0000-0000-000000000001',title:'test',description:'test',timeframe_note:'',status:'draft',revision:0},chat_revision:1,runs:[{id:'fixture-run',turn_index:1,user_text:'test',status:'succeeded',error_code:null,reply:{schema_version:1,kind:'question',question:'每周几次？',reason:'了解时间',source:'deepseek'}}]};
test('schedule trial provenance, exact duration, windows, dependencies and preview status are checked',()=>{
 const id='00000000-0000-0000-0000-000000000001',start=Date.parse('2026-10-20T12:00:00Z');
 const schedule={attempt_id:id,goal_revision:0,review_revision:0,timezone:'Asia/Shanghai',windows:[{start_at:start,end_at:start+3600000}],scope:'first_stage_once_v1',tasks:[{id,title:'练习',duration_minutes:20,depends_on:[]}]};
 const reply={schema_version:1,source:'harness',kind:'notice',question:'核对时段',reason:'只做试排',requested_slot:null,stage:'schedule_proposed',schedule};
 assert.equal(checkedDialogue({...base,runs:[{...base.runs[0],reply}]}).runs[0].reply.schedule.scope,'first_stage_once_v1');
 assert.throws(()=>checkedDialogue({...base,runs:[{...base.runs[0],reply:{...reply,source:'deepseek'}}]}));
 const preview={...schedule,confirmed_from_run_id:id,preview:{schema_version:1,status:'preview_only',strategy:'stable_topological_earliest_v1',timezone:'Asia/Shanghai',placements:[{task_id:id,start_at:start,end_at:start+1200000}],unplaced:[]}};
 checkedSchedule(preview,'schedule_preview');
 for(const patch of [{status:'scheduled'},{placements:[{task_id:id,start_at:start,end_at:start+60000}]},{placements:[{task_id:id,start_at:start-1,end_at:start+1200000-1}]},{unplaced:[{task_id:id,reason:'no_legal_window'}]}])assert.throws(()=>checkedSchedule({...preview,preview:{...preview.preview,...patch}},'schedule_preview'));
 assert.throws(()=>checkedSchedule({...schedule,tasks:[{...schedule.tasks[0],depends_on:[id]}]},'schedule_proposed'));
 assert.match(scheduleTime(start,'Asia/Shanghai'),/20:00/);
 assert.equal(isScheduleText('可用时段：北京时间，2026-10-20 20:00-21:00'),true);
});
test('dialogue provenance and completion state cannot be forged',()=>{
  assert.equal(checkedDialogue(base).runs[0].reply.source,'deepseek');
  for(const reply of [{...base.runs[0].reply,source:'policy'},{...base.runs[0].reply,schema_version:2},null])assert.throws(()=>checkedDialogue({...base,runs:[{...base.runs[0],reply}]}));
  assert.throws(()=>checkedDialogue({...base,runs:[{...base.runs[0],status:'running'}]}));
  assert.equal(checkedDialogue({...base,runs:[{...base.runs[0],status:'running',reply:null}]}).runs[0].status,'running');
});
test('suggestions are quoted, unconfirmed and bound to the same goal revision',()=>{
  const suggestions=[{key:'available_time',text:'每晚20分钟',evidence:'每晚20分钟'}];
  const value={...base,runs:[{...base.runs[0],user_text:'每晚20分钟',goal_revision:0,reply:{...base.runs[0].reply,suggestions}}]};
  const checked=checkedDialogue(value);
  assert.deepEqual(reviewSuggestions(checked,'fixture-run',0),suggestions);
  assert.throws(()=>reviewSuggestions(checked,'fixture-run',1));
  assert.throws(()=>reviewSuggestions({...checked,goal:{...checked.goal,status:'paused'}},'fixture-run',0));
  assert.throws(()=>reviewSuggestions(checked,'other-run',0));
  assert.throws(()=>checkedDialogue({...value,runs:[{...value.runs[0],user_text:'不同消息'}]}));
  assert.throws(()=>checkedDialogue({...value,runs:[{...value.runs[0],reply:{...value.runs[0].reply,suggestions:[...suggestions,...suggestions]}}]}));
});
test('failure messages describe retained state without exposing raw provider errors',()=>{
  assert.match(dialogueError('AI_TIMEOUT'),/消息已保存/);
  assert.match(dialogueError('CONTEXT_CHANGED'),/输入仍保留/);
  assert.ok(!dialogueError('upstream-private-key').includes('upstream-private-key'));
});

test('chat collection metadata accepts internal keys but cannot masquerade as policy or arbitrary phases',()=>{
 const reply={...base.runs[0].reply,requested_slot:'outcome',stage:'clarifying'};assert.equal(checkedDialogue({...base,runs:[{...base.runs[0],reply}]}).runs[0].reply.requested_slot,'outcome');
 for(const override of [{requested_slot:'calendar'},{stage:'scheduled'},{source:'policy',kind:'referral'}])assert.throws(()=>checkedDialogue({...base,runs:[{...base.runs[0],reply:{...reply,...override}}]}));
});

test('harness stop notices cannot masquerade as generated drafts or model actions',()=>{const reply={schema_version:1,kind:'notice',source:'harness',question:'已停止提问，草稿生成尚未接通。',reason:'缺失信息仍未知',requested_slot:null,stage:'draft_requested'};assert.equal(checkedDialogue({...base,runs:[{...base.runs[0],reply}]}).runs[0].reply.stage,'draft_requested');for(const patch of [{source:'deepseek'},{requested_slot:'outcome'},{stage:'scheduled'},{suggestions:[]}])assert.throws(()=>checkedDialogue({...base,runs:[{...base.runs[0],reply:{...reply,...patch}}]}));});

test('three-topic progress is distinct internal metadata, never a repeated-turn count',()=>{assert.equal(checkedDialogue({...base,asked_topics:['outcome','available_time','constraints']}).asked_topics.length,3);for(const topics of [['outcome','outcome'],['calendar'],['outcome','available_time','constraints','outcome']])assert.throws(()=>checkedDialogue({...base,asked_topics:topics}));});

test('clarification budget validates remaining counts and never confuses three topics with daily quota',()=>{const clarification_budget={daily_limit:24,used:8,remaining:16,reset_at:123,global_limited:false,allowed:true};assert.equal(checkedDialogue({...base,clarification_budget}).clarification_budget.remaining,16);for(const patch of [{remaining:99},{allowed:false},{used:-1},{daily_limit:999}])assert.throws(()=>checkedDialogue({...base,clarification_budget:{...clarification_budget,...patch}}));assert.throws(()=>checkedDialogue({...base,clarification_budget:null}));assert.equal(checkedDialogue({...base,clarification_budget:{...clarification_budget,global_limited:true,allowed:false}}).clarification_budget.allowed,false);assert.match(dialogueError('AI_DAILY_LIMIT'),/停止提问/);});

test('chat edit differences reject fabricated totals, fields and receipt versions',()=>{const proposal={attempt_id:'00000000-0000-0000-0000-000000000001',task_id:'00000000-0000-0000-0000-000000000002',task_title:'练习',goal_revision:0,review_revision:0,before:{duration_minutes:20,frequency_per_week:3},after:{duration_minutes:15,frequency_per_week:4},weekly_before:60,weekly_after:60};const reply={schema_version:1,kind:'notice',source:'harness',question:'请核对差异',reason:'不自动保存',requested_slot:null,stage:'edit_proposed',edit_proposal:proposal};assert.equal(checkedDialogue({...base,runs:[{...base.runs[0],reply,edit_receipt_revision:1}]}).runs[0].edit_receipt_revision,1);for(const patch of [{weekly_after:999},{after:{duration_minutes:999,frequency_per_week:4}},{task_id:'forged'}])assert.throws(()=>checkedDialogue({...base,runs:[{...base.runs[0],reply:{...reply,edit_proposal:{...proposal,...patch}}}]}));assert.throws(()=>checkedDialogue({...base,runs:[{...base.runs[0],reply,edit_receipt_revision:21}]}));assert.throws(()=>checkedDialogue({...base,runs:[{...base.runs[0],reply:{...reply,source:'deepseek'}}]}));});
