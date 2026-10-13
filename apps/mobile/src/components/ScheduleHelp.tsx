import {useState} from 'react';
import {Action,AppText,Caption,Card} from './ui';
export function ScheduleHelp({example}:{example:string}){const [open,setOpen]=useState(false);return <><Action label={open?'收起回答示例':'查看回答示例'} secondary onPress={()=>setOpen(v=>!v)}/>{open&&<Card><Caption>目前支持明确日期与北京时间或UTC，例如：</Caption><AppText selectable style={{fontSize:15}}>{example}</AppText><Caption>多个时段用分号分开。日期、时区或时间不明确时，会继续核对，不会自动安排。</Caption></Card>}</>;}
