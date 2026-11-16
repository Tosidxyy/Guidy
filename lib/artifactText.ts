// 助手文本里的产物 JSON 不应原样显示在气泡中：拆出可读前言/后语，JSON 段交给生成动画与确认卡。
export interface SplitArtifactText {
  prose: string;
  artifactJson: string | null;
}

const FENCE = '```json';

export function splitArtifactText(content: string): SplitArtifactText {
  const fence = content.indexOf(FENCE);
  if (fence >= 0) {
    const before = content.slice(0, fence);
    const body = content.slice(fence + FENCE.length);
    const close = body.indexOf('```');
    const json = (close >= 0 ? body.slice(0, close) : body).trim();
    const after = close >= 0 ? body.slice(close + 3) : '';
    const prose = [before.trim(), after.trim()].filter(Boolean).join('\n\n');
    return { prose, artifactJson: json };
  }
  const bare = content.match(/(?:^|\n)[ \t]*\{[\s\S]*?"type"\s*:/);
  if (bare && bare.index !== undefined) {
    const brace = content.indexOf('{', bare.index);
    return { prose: content.slice(0, brace).trim(), artifactJson: content.slice(brace).trim() };
  }
  return { prose: content, artifactJson: null };
}