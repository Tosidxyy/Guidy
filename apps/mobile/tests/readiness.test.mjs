import assert from 'node:assert/strict';
import test from 'node:test';
import { checkedReadiness } from '../src/goals/readiness.ts';
const ready={schema_version:1,goal_revision:2,phase:'research_preparation',confirmed_keys:['outcome','available_time'],missing_required:[],unknown_optional:['constraints']};
test('readiness rejects stale revisions and contradictory missing requirements',()=>{
  assert.equal(checkedReadiness(ready,2).phase,'research_preparation');
  for(const value of [{...ready,goal_revision:1},{...ready,confirmed_keys:['outcome']},{...ready,missing_required:['available_time']},{...ready,unknown_optional:[]},{...ready,phase:'plan_ready'}])assert.throws(()=>checkedReadiness(value,2));
});
