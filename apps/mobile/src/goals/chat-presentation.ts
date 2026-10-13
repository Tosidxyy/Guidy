import type {DialogueRun} from './dialogue';
import {ASK_WEEK,ASK_SCHEDULE,CONFIRM_WEEK,CONFIRM_SCHEDULE} from './schedule.ts';
export function chatPresentation(run:DialogueRun){
 const label:Record<string,string>={[ASK_WEEK]:'看看接下来一周怎么安排',[ASK_SCHEDULE]:'看看具体时间怎么安排',[CONFIRM_WEEK]:'这些时段可以，先看看一周安排',[CONFIRM_SCHEDULE]:'这些时段可以，看看安排'};
 let question=run.reply?.question??'';
 if(run.reply?.source==='harness'&&run.reply.stage==='schedule_guidance'){
  if(question.startsWith('请提供首个日期起连续7天内'))question='接下来一周，你具体哪几天、什么时段有空？请同时说明时区。';
  else if(question.startsWith('哪几个具体日期和时段有空？'))question='你具体哪几天、什么时段有空？请同时说明时区。';
 }
 const legacy=run.reply?.source==='harness'&&run.reply.stage==='schedule_guidance'?run.reply.question.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}-\d{2}:\d{2}/)?.[0]:undefined;
 return {userText:label[run.user_text]??run.user_text,question,example:run.reply?.schedule_help?.example_text??(legacy?`北京时间，${legacy}`:undefined)};
}
