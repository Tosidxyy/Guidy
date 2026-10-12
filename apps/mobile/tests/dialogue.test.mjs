import assert from 'node:assert/strict';
import test from 'node:test';
import { checkedDialogue, dialogueError, reviewSuggestions } from '../src/goals/dialogue.ts';
const base={goal:{id:'00000000-0000-0000-0000-000000000001',title:'test',description:'test',timeframe_note:'',status:'draft',revision:0},chat_revision:1,runs:[{id:'fixture-run',turn_index:1,user_text:'test',status:'succeeded',error_code:null,reply:{schema_version:1,kind:'question',question:'每周几次？',reason:'了解时间',source:'deepseek'}}]};
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
