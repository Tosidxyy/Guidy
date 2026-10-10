export type Evidence = {id:string;goal_revision:number;source_url:string;claim:string;caveat:string;status:'fetching'|'available'|'failed';verification_status:'unverified';title:string;excerpt:string;error_code:string|null;retrieved_at:number|null;created_at:number};
export function checkedEvidence(value:unknown):Evidence[]{
  if(!Array.isArray(value)||value.length>20)throw new Error('来源响应格式不正确。');
  for(const e of value){
    if(!e||typeof e.id!=='string'||!Number.isSafeInteger(e.goal_revision)||e.goal_revision<0||typeof e.source_url!=='string'||!['fetching','available','failed'].includes(e.status)||e.verification_status!=='unverified'||typeof e.claim!=='string'||e.claim.length>300||typeof e.caveat!=='string'||e.caveat.length>300||typeof e.title!=='string'||e.title.length>160||typeof e.excerpt!=='string'||e.excerpt.length>1200||(e.status==='available'&&(!e.excerpt||!Number.isSafeInteger(e.retrieved_at))))throw new Error('来源状态未通过校验。');
    const url=new URL(e.source_url);if(url.protocol!=='https:'||!['learnenglish.britishcouncil.org','www.nhs.uk','www.who.int','www.aad.org'].includes(url.hostname)||url.username||url.password||url.port||url.search)throw new Error('来源链接未通过校验。');
  }
  return value;
}
export function sourceError(code:string):string{
  if(code==='SOURCE_URL_REJECTED')return '暂仅支持 British Council、NHS、WHO、AAD 的指定官网 HTTPS 网页，不含查询参数。';
  if(code==='SOURCE_REDIRECT_REJECTED')return '来源发生跳转，请打开官网后复制最终网页链接。';
  if(code==='SOURCE_TOO_LARGE')return '网页超过读取上限，请选择较短的资料页。';
  if(code==='SOURCE_TYPE_REJECTED')return '暂只读取 HTML 网页，不支持 PDF 或文件。';
  if(code==='SOURCE_TIMEOUT')return '读取超时，未核实资料；可以保留链接后明确重试。';
  if(code==='SOURCE_LIMIT_OR_BUSY')return '有资料正在读取或已达到测试上限，请先读取状态。';
  return '来源未读取成功，未核实资料。请检查链接或读取最新状态。';
}
