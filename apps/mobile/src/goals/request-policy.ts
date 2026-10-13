export function requestTimeout(path:string){return path.endsWith('/plan-drafts')?40000:['/messages','/evidence','/research-runs','/search-runs','/planning-runs'].some(s=>path.endsWith(s))?30000:10000;}
export const PLANNING_READ_INTERRUPTED='方案状态暂未读取成功，草稿可能已保存。请重新读取状态，不要重复生成。';
