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

import {checkedPlans,planError} from '../src/goals/plans.ts';
test('draft review rejects fake acceptance, unknown citations, cycles and forged effort totals',()=>{
 const goal='00000000-0000-0000-0000-000000000001',source='00000000-0000-0000-0000-000000000002',task='00000000-0000-0000-0000-000000000003';
 const item={id:task,key:'t1',stage:1,title:'练习',instructions:'练习并记录结果',duration_minutes:20,frequency_per_week:3,mandatory:true,depends_on:[],evidence_ids:[source]};
 const draft={schema_version:1,status:'draft',verification_status:'unverified',title:'学习草稿',summary:'练习与复盘',assumptions:[],risks:['资料未核实'],tasks:[item],weekly_minutes:60,time_fit:'needs_user_review',cost_status:'unknown',scheduling_status:'not_checked'};
 const context={schema_version:1,goal:{description:'学习',timeframe_note:''},conditions:['outcome','available_time'].map(key=>({key,source:'user',confirmed_at:1,value:{schema_version:1,state:'confirmed',text:'用户确认条件'}})),sources:[{source_id:source,search_id:goal,searched_at:123,provider_request_id:'test',title:'资料',url:'https://example.org/',snippet:'片段',content:'正文',content_kind:'provider_content',published_at:null,verification_status:'unverified'}]};
 const attempt={id:goal,goal_revision:0,status:'succeeded',error_code:null,draft,context,billing_status:'reserved_unknown',created_at:123};const snapshot={goal:{id:goal,revision:0,status:'draft'},attempts:[attempt]};
 assert.equal(checkedPlans(snapshot,goal).attempts[0].draft.weekly_minutes,60);
 for(const d of [{...draft,status:'confirmed'},{...draft,weekly_minutes:1},{...draft,tasks:[{...item,evidence_ids:['fake']}]},{...draft,tasks:[{...item,depends_on:[task]}]},{...draft,scheduling_status:'scheduled'}])assert.throws(()=>checkedPlans({...snapshot,attempts:[{...attempt,draft:d}]},goal));
 assert.throws(()=>checkedPlans({...snapshot,attempts:[{...attempt,context:{...context,sources:[{...context.sources[0],url:'javascript:alert(1)'}]}}]},goal));
 assert.throws(()=>checkedPlans(snapshot,source));
 assert.equal(checkedPlans({...snapshot,attempts:[{...attempt,status:'unknown',draft:null,error_code:'PLAN_RESULT_UNKNOWN'}]},goal).attempts[0].status,'unknown');
 assert.match(planError('PLAN_RESULT_UNKNOWN'),/不会自动/);
 assert.ok(!planError('private raw response').includes('private'));
});

test('draft limit and field diagnostics do not silently grant arbitrary model budgets',()=>{
 assert.match(planError('PLAN_SCHEMA_SUMMARY'),/摘要/);
 assert.match(planError('PLAN_SCHEMA_FIELDS'),/字段/);
 const bad={daily_limit:99,goal:{id:'00000000-0000-0000-0000-000000000001',revision:0,status:'draft'},attempts:[]};assert.throws(()=>checkedPlans(bad,bad.goal.id));assert.equal(checkedPlans({...bad,daily_limit:4},bad.goal.id).daily_limit,4);
});

import {checkedReviews,reviewNumber,reviewError} from '../src/goals/plans.ts';
test('review snapshots allow only numeric effort changes while preserving task identity, references and draft status',()=>{
 const goal='00000000-0000-0000-0000-000000000001',attempt='00000000-0000-0000-0000-000000000002',source='00000000-0000-0000-0000-000000000003',task='00000000-0000-0000-0000-000000000004';
 const draft={schema_version:1,status:'draft',verification_status:'unverified',title:'学习',summary:'练习与复盘',assumptions:[],risks:['未核实'],tasks:[{id:task,key:'t1',stage:1,title:'练习',instructions:'原步骤保持',duration_minutes:20,frequency_per_week:3,mandatory:true,depends_on:[],evidence_ids:[source]}],weekly_minutes:60,time_fit:'needs_user_review',cost_status:'unknown',scheduling_status:'not_checked'};
 const context={schema_version:1,goal:{description:'学习',timeframe_note:''},conditions:['outcome','available_time'].map(key=>({key,source:'user',confirmed_at:1,value:{schema_version:1,state:'confirmed',text:'确认条件'}})),sources:[{source_id:source,search_id:goal,searched_at:123,provider_request_id:'test',title:'资料',url:'https://example.org/',snippet:'摘要',content:'正文',content_kind:'provider_content',published_at:null,verification_status:'unverified'}]};
 const changed={...draft,weekly_minutes:90,tasks:[{...draft.tasks[0],duration_minutes:30}]};const v={goal:{id:goal,status:'draft',revision:0},can_edit:true,source:{id:attempt,goal_revision:0,status:'succeeded',error_code:null,draft,context,billing_status:'reserved_unknown',created_at:123},current_revision:1,receipt_revision:1,reviews:[{id:source,revision:1,source:'user',created_at:123,draft:changed}]};assert.equal(checkedReviews(v,goal,attempt).reviews[0].draft.weekly_minutes,90);assert.throws(()=>checkedReviews({...v,reviews:[{...v.reviews[0],draft:{...changed,title:'篡改标题'}}]},goal,attempt));assert.throws(()=>checkedReviews({...v,current_revision:2},goal,attempt));assert.throws(()=>checkedReviews(v,goal,task));
});
test('review integer input rejects prefixes, decimals and range overflow while accepting full-width digits',()=>{
 assert.equal(reviewNumber('３０',5,120),30);for(const value of ['','30abc','20.5','-5','121'])assert.equal(reviewNumber(value,5,120),null);assert.equal(reviewNumber('8',1,7),null);assert.match(reviewError('REVIEW_VERSION_CHANGED'),/输入仍保留/);assert.ok(!reviewError('private upstream content').includes('private'));
});
