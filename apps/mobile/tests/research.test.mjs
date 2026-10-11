import assert from 'node:assert/strict';
import test from 'node:test';
import { checkedEvidence,checkedJobs,jobError,sourceError } from '../src/goals/research.ts';
test('retrieved source cannot masquerade as verified evidence or an arbitrary link',()=>{
  const e={id:'fixture',goal_revision:0,source_url:'https://www.nhs.uk/',claim:'question',caveat:'',status:'available',verification_status:'unverified',title:'test',excerpt:'untrusted text',retrieved_at:123,created_at:123};
  assert.equal(checkedEvidence([e])[0].verification_status,'unverified');
  for(const override of [{verification_status:'verified'},{retrieved_at:null},{source_url:'https://evil.invalid/'},{excerpt:''}])assert.throws(()=>checkedEvidence([{...e,...override}]));
  assert.ok(!sourceError('private upstream token').includes('private upstream token'));
});
test('job completion cannot hide pending work and dispatch failure remains explicit',()=>{
  const item={position:0,source_url:'https://www.nhs.uk/',claim:'question',caveat:'',status:'available',title:'test',excerpt:'untrusted',retrieved_at:123,error_code:null};
  const job={id:'fixture',goal_revision:0,status:'completed',dispatched:1,error_code:null,items:[item]};
  assert.equal(checkedJobs([job])[0].status,'completed');
  assert.throws(()=>checkedJobs([{...job,items:[{...item,status:'pending'}]}]));
  assert.throws(()=>checkedJobs([{...job,items:[item,item]}]));
  assert.match(jobError('WORKFLOW_START_FAILED'),/任务已保存/);
});
test('website denial gives an actionable reason without claiming success',()=>{
  assert.match(sourceError('SOURCE_ACCESS_DENIED'),/拒绝服务器读取/);
  assert.match(sourceError('SOURCE_RATE_LIMITED'),/限流/);
  assert.match(sourceError('CONTEXT_CHANGED'),/输入仍保留/);
});
