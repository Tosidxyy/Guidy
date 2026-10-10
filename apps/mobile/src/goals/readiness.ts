export type Readiness = {
  schema_version: 1;
  goal_revision: number;
  phase: 'needs_confirmation' | 'needs_review' | 'research_preparation' | 'paused' | 'read_only';
  confirmed_keys: string[];
  missing_required: string[];
  unknown_optional: string[];
};
export function checkedReadiness(value: Readiness, revision: number): Readiness {
  const keys=['outcome','available_time','constraints'];
  if(!value||value.schema_version!==1||value.goal_revision!==revision||!['needs_confirmation','needs_review','research_preparation','paused','read_only'].includes(value.phase))throw new Error('澄清进度格式不正确。');
  for(const list of [value.confirmed_keys,value.missing_required,value.unknown_optional]){
    if(!Array.isArray(list)||list.length>3||new Set(list).size!==list.length||list.some(k=>!keys.includes(k)))throw new Error('澄清进度格式不正确。');
  }
  const missing=['outcome','available_time'].filter(k=>!value.confirmed_keys.includes(k));
  if(JSON.stringify(value.missing_required)!==JSON.stringify(missing)||JSON.stringify(value.unknown_optional)!==JSON.stringify(value.confirmed_keys.includes('constraints')?[]:['constraints'])||(value.phase==='research_preparation'&&missing.length)||(value.phase==='needs_confirmation'&&!missing.length))throw new Error('澄清进度不一致，请重新读取。');
  return value;
}
