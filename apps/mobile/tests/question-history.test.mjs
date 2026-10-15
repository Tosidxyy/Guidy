import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedHistory} from '../src/goals/question-history.ts';
const goal='00000000-0000-4000-8000-000000000001';
const card=(i)=>({id:'00000000-0000-4000-8000-'+String(i).padStart(12,'0'),turn_index:i,question:'问题'+i,answer:'回答'+i});
test('history checks page provenance, bounded chronological cards and exact cursor progress',()=>{
 const data={goal_id:goal,cards:Array.from({length:20},(_,i)=>card(i+5)),next_before:5};checkedHistory(data,goal,25);
 for(const forged of [{...data,goal_id:'other'},{...data,next_before:6},{...data,cards:[...data.cards,card(30)]},{...data,cards:[data.cards[1],data.cards[0]]},{...data,cards:[{...card(1),question:''}],next_before:null},{...data,cards:[{...card(1),answer:42}],next_before:null}])assert.throws(()=>checkedHistory(forged,goal,25));
 assert.throws(()=>checkedHistory(data,goal,20));
});
test('empty and unanswered history are honest terminal pages; cursor cannot skip or repeat',()=>{
 checkedHistory({goal_id:goal,cards:[],next_before:null},goal);
 checkedHistory({goal_id:goal,cards:[{...card(1),answer:null}],next_before:null},goal,2);
 assert.throws(()=>checkedHistory({goal_id:goal,cards:[],next_before:1},goal));
 assert.throws(()=>checkedHistory({goal_id:goal,cards:[card(1),card(1)],next_before:null},goal));
});
