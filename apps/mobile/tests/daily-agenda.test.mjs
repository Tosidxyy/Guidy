import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyBlocks,clockTime} from '../src/goals/daily-agenda.ts';
test('a session becomes exact contiguous actionable blocks, never extra empty time',()=>{
 const start=Date.parse('2026-10-16T12:00:00Z');
 const blocks=dailyBlocks({id:'a',title:'韩语练习',instructions:'原有做法',start_at:start,end_at:start+20*60000,segments:[{title:'听音',instructions:'听三句并标出陌生发音',duration_minutes:5},{title:'跟读',instructions:'逐句模仿，录音并比较',duration_minutes:15}]});
 assert.equal(blocks.length,2);assert.equal(blocks[0].end_at,blocks[1].start_at);assert.equal(blocks[1].end_at,start+20*60000);
 assert.equal(clockTime(blocks[0].start_at,'Asia/Shanghai'),'20:00');assert.equal(clockTime(blocks[1].start_at,'Asia/Shanghai'),'20:05');assert.equal(blocks[1].instructions,'逐句模仿，录音并比较');
});
test('legacy or inconsistent breakdown displays the original assigned session without invented steps',()=>{
 const item={id:'x',title:'练习',instructions:'原任务的做法',start_at:1000,end_at:1201000};
 for(const segments of [undefined,[],[{title:'错误',instructions:'不应显示',duration_minutes:5}]]){const b=dailyBlocks({...item,segments});assert.equal(b.length,1);assert.equal(b[0].instructions,item.instructions);assert.equal(b[0].end_at,item.end_at);}
});
