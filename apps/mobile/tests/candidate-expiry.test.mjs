import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateExpired,candidateKeyCurrent,planningDay} from '../src/goals/candidate-expiry.ts';
import {automaticScheduleKey} from '../../../backend/src/scheduling/automatic-key.ts';
test('server and client keys roll over at the planning timezone midnight',()=>{
 const before=Date.parse('2026-10-15T15:59:59Z'),after=before+1000,id=crypto.randomUUID();
 assert.equal(planningDay('Asia/Shanghai',after),planningDay('Asia/Shanghai',before)+1);
 assert.equal(planningDay('UTC',after),planningDay('UTC',before));
 for(const zone of ['Asia/Shanghai','UTC']){
  const key=automaticScheduleKey(id,2,4,zone,before);
  assert.equal(candidateKeyCurrent(key,zone,before),true);
  assert.equal(candidateKeyCurrent(key,zone,after),zone==='UTC');
 }
});
test('only expired candidate placements, unplaced deadlines or ended periods require recovery',()=>{
 const now=1000,s={windows:[{start_at:1,end_at:2000}],tasks:[{id:'a',deadline_at:3000}],period:{start_at:1,end_at:4000},preview:{placements:[{task_id:'a',start_at:2000,end_at:2500}],unplaced:[]}};
 assert.equal(candidateExpired(s,now),false); // remaining-plan windows may include the past
 assert.equal(candidateExpired(s,2000),true);
 const unplaced={...s,preview:{placements:[],unplaced:[{task_id:'a'}]}};
 assert.equal(candidateExpired(unplaced,2999),false);
 assert.equal(candidateExpired(unplaced,3000),true);
 assert.equal(candidateExpired({...s,preview:{placements:[],unplaced:[]}},4000),true);
});
