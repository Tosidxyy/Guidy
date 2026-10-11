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

import {checkedSearchSnapshot,validSearchQuery,searchError,safeSearchLink} from '../src/goals/search.ts';
test('search snapshots reject forged verification, unsafe links, wrong goals and missing provider content',()=>{
  const id='00000000-0000-0000-0000-000000000001';
  const source={source_id:id,title:'资料',url:'https://example.org/',snippet:'片段',content:'正文',content_kind:'provider_content',published_at:null,verification_status:'unverified'};
  const attempt={id,goal_revision:0,query:'英语学习方法',provider:'doubao-custom',status:'succeeded',billing_status:'reserved_unknown',error_code:null,created_at:123,result:{provider:'doubao-custom',provider_request_id:'synthetic',searched_at:123,sources:[source]}};
  const snapshot={goal:{id,revision:0,status:'draft'},attempts:[attempt]};
  assert.equal(checkedSearchSnapshot(snapshot,id).attempts[0].result.sources.length,1);
  for(const override of [{url:'javascript:alert(1)'},{url:'https://user:password@example.org/'},{url:'https://127.0.0.1/'},{verification_status:'verified'},{content:''},{content_kind:'snippet_only'}])assert.throws(()=>checkedSearchSnapshot({...snapshot,attempts:[{...attempt,result:{...attempt.result,sources:[{...source,...override}]}}]},id));
  assert.throws(()=>checkedSearchSnapshot(snapshot,'00000000-0000-0000-0000-000000000002'));
  assert.throws(()=>checkedSearchSnapshot({...snapshot,attempts:[{...attempt,status:'unknown'}]},id));
  assert.equal(checkedSearchSnapshot({...snapshot,attempts:[{...attempt,status:'unknown',result:null,error_code:'SEARCH_RESULT_UNKNOWN'}]},id).attempts[0].status,'unknown');
});
test('generic queries, safe link opening and unknown billing errors do not imply automatic retries',()=>{
  assert.ok(validSearchQuery('英语初学者学习方法'));
  for(const q of ['','x'.repeat(101),'person@example.org','13800138000','a\nb','https://example.org'])assert.equal(validSearchQuery(q),false);
  assert.equal(safeSearchLink('https://example.org/article'),true);
  assert.equal(safeSearchLink('https://localhost/'),false);
  assert.match(searchError('SEARCH_RESULT_UNKNOWN'),/不会自动/);
  assert.ok(!searchError('private provider body').includes('private'));
});
