import test from 'node:test';
import assert from 'node:assert/strict';
import {currentQuestion,failedQuestionAnswer} from '../src/goals/question-recovery.ts';
const question={id:'q1',turn_index:1,status:'succeeded',user_text:'开始',reply:{kind:'question',question:'希望达到什么结果？'}};
const failed={id:'f1',turn_index:2,status:'failed',user_text:'五周后能完成旅行对话。',reply:null};
test('failed answers keep the original question editable and restore exact text across repeated failures',()=>{
 const data={runs:[question,failed]};assert.equal(currentQuestion(data).id,'q1');assert.equal(failedQuestionAnswer(data),failed.user_text);
 data.runs.push({...failed,id:'f2',turn_index:3});assert.equal(currentQuestion(data).id,'q1');assert.equal(failedQuestionAnswer(data),failed.user_text);
 data.runs.push({...question,id:'q2',turn_index:4});assert.equal(currentQuestion(data).id,'q2');assert.equal(failedQuestionAnswer(data),'');
});
test('running, successful notices and internal commands never become a recovered user answer',()=>{
 for(const tail of [{...failed,status:'running'},{...failed,status:'succeeded',reply:{kind:'notice'}}])assert.equal(currentQuestion({runs:[question,tail]}),null);
 assert.equal(failedQuestionAnswer({runs:[question,{...failed,user_text:'请继续问我一个有助于完善方案的问题。'}]}),'');
 assert.equal(failedQuestionAnswer({runs:[question,{...failed,user_text:'根据当前回答开始制订：周三没空'}]}),'周三没空');
 assert.equal(currentQuestion({runs:[]}),null);
});
