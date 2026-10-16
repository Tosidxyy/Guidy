import assert from 'node:assert/strict';
import test from 'node:test';
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

import {checkedPlanning} from '../src/goals/planning.ts';
test('automatic drafts permit explicit unknowns without sources, reject fake citations and forged completion',()=>{
 const id='00000000-0000-0000-0000-000000000001',run='00000000-0000-0000-0000-000000000002';const draft={schema_version:1,status:'draft',verification_status:'unverified',title:'建议',summary:'试行',assumptions:['未知时间'],risks:[],weekly_minutes:60,time_fit:'needs_user_review',cost_status:'unknown',scheduling_status:'not_checked',tasks:[{id:run,key:'t1',stage:1,title:'练习',instructions:'练习并复盘',duration_minutes:20,frequency_per_week:3,mandatory:true,depends_on:[],evidence_ids:[]}]};
 const context={schema_version:1,generation_mode:'chat_auto_v1',goal:{description:'学习',timeframe_note:''},conditions:['outcome','available_time','constraints'].map(key=>({key,source:'user',confirmed_at:null,value:{schema_version:1,state:'unknown',text:''}})),sources:[]};const plan={id,goal_revision:0,status:'succeeded',error_code:null,context,draft,created_at:123,billing_status:'reserved_unknown'};const goal={id,revision:0,status:'draft'};const job={id,source_run_id:run,goal_revision:0,status:'completed',error_code:null,dispatched:1,created_at:123,plan};
 assert.equal(checkedPlanning({goal,jobs:[job]},id).jobs[0].plan.context.sources.length,0);const review={id:run,revision:1,created_at:123,weekly_capacity_minutes:null,draft:{...draft,weekly_minutes:45,tasks:[{...draft.tasks[0],duration_minutes:15}]}};assert.equal(checkedPlanning({goal,jobs:[{...job,review}]},id).jobs[0].review.draft.weekly_minutes,45);assert.throws(()=>checkedPlanning({goal,jobs:[{...job,review:{...review,draft:{...review.draft,title:'伪造标题'}}}]},id));assert.throws(()=>checkedPlanning({goal,jobs:[{...job,plan:null}]},id));assert.throws(()=>checkedPlanning({goal,jobs:[{...job,plan:{...plan,draft:{...draft,tasks:[{...draft.tasks[0],evidence_ids:['fake']}]}}}]},id));assert.throws(()=>checkedPlans({goal,attempts:[{...plan,context:{...context,generation_mode:undefined}}]},id));
});
