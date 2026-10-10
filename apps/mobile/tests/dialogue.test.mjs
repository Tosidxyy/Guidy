import assert from 'node:assert/strict';
import test from 'node:test';
import { checkedDialogue, dialogueError } from '../src/goals/dialogue.ts';
const base={goal:{id:'00000000-0000-0000-0000-000000000001',title:'test',description:'test',timeframe_note:'',status:'draft',revision:0},chat_revision:1,runs:[{id:'fixture-run',turn_index:1,user_text:'test',status:'succeeded',error_code:null,reply:{schema_version:1,kind:'question',question:'每周几次？',reason:'了解时间',source:'deepseek'}}]};
test('dialogue provenance and completion state cannot be forged',()=>{
  assert.equal(checkedDialogue(base).runs[0].reply.source,'deepseek');
  for(const reply of [{...base.runs[0].reply,source:'policy'},{...base.runs[0].reply,schema_version:2},null])assert.throws(()=>checkedDialogue({...base,runs:[{...base.runs[0],reply}]}));
  assert.throws(()=>checkedDialogue({...base,runs:[{...base.runs[0],status:'running'}]}));
  assert.equal(checkedDialogue({...base,runs:[{...base.runs[0],status:'running',reply:null}]}).runs[0].status,'running');
});
test('failure messages describe retained state without exposing raw provider errors',()=>{
  assert.match(dialogueError('AI_TIMEOUT'),/消息已保存/);
  assert.match(dialogueError('CONTEXT_CHANGED'),/输入仍保留/);
  assert.ok(!dialogueError('upstream-private-key').includes('upstream-private-key'));
});
