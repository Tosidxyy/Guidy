import type {Dialogue} from './dialogue.ts';
export function currentQuestion(data:Dialogue){
 const question=data.runs.findLast(r=>r.reply?.kind==='question');
 if(!question)return null;
 const after=data.runs.filter(r=>r.turn_index>question.turn_index);
 return after.every(r=>r.status==='failed')?question:null;
}
export function failedQuestionAnswer(data:Dialogue){
 const last=data.runs.at(-1);
 if(!currentQuestion(data)||last?.status!=='failed')return '';
 const text=last.user_text;
 if(text.startsWith('根据当前回答开始制订：'))return text.slice('根据当前回答开始制订：'.length).slice(0,500);
 if(['请根据我的目标和已确认条件，提出一个必要的澄清问题。','请继续问我一个有助于完善方案的问题。','请继续澄清仍未明确的条件。','先到这里，请根据现有信息准备方案草稿。','请根据现有信息直接拟定一周安排。'].includes(text))return '';
 return text.length<=500?text:'';
}
