// 助手文本里的产物 JSON 不应原样显示在气泡中：拆出可读前言/后语，JSON 段交给生成动画与确认卡。
// 客户端气泡与服务端落库共用同一剥离逻辑，避免历史/恢复路径漏出原文 JSON。
export interface SplitArtifactText {
  prose: string;
  artifactJson: string | null;
}

const FENCE = '```json';

// 气泡里不该出现围栏残留或空引号（模型偶发只吐 ``` / ```json、或空 ‘’)：统一清掉。
function tidyProse(prose: string): string {
  return prose
    .replace(/```(?:json)?[ \t]*\n?[\s\S]*?```/g, ' ')
    .replace(/```(?:json)?/g, '')
    .replace(/`{1,3}/g, '')
    .replace(/‘’|“”|''|""/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function splitArtifactText(content: string): SplitArtifactText {
  // 兼容 ```json 与裸 ``` 围栏（后接 JSON 对象）。
  const fenceMatch = content.match(/```(?:json)?[ \t]*(?=\{)/);
  const fence = fenceMatch?.index ?? content.indexOf(FENCE);
  if (fence >= 0) {
    const before = content.slice(0, fence);
    const body = content.slice(fence).replace(/^```(?:json)?[ \t]*/, '');
    const close = body.indexOf('```');
    const json = (close >= 0 ? body.slice(0, close) : body).trim();
    const after = close >= 0 ? body.slice(close + 3) : '';
    const prose = [before, after].map((s) => s.trim()).filter(Boolean).join('\n\n');
    return { prose: tidyProse(prose), artifactJson: json };
  }
  // 行内/行首裸 JSON 对象（含 "type" 字段）都视为产物，不进气泡。
  const bare = content.match(/\{[\s\S]*?"type"\s*:/);
  if (bare && bare.index !== undefined) {
    return { prose: tidyProse(content.slice(0, bare.index)), artifactJson: content.slice(bare.index).trim() };
  }
  return { prose: tidyProse(content), artifactJson: null };
}