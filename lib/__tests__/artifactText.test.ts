import { describe, expect, it } from 'vitest';
import { splitArtifactText } from '../artifactText';

const JSON_SET = '{"type":"constraint_set","plan_title":"新手增肌","horizon_days":7,"task_defs":[],"constraints":[],"clarifications_needed":[]}';

describe('splitArtifactText — 助手文本拆成可读前言 + 产物 JSON（JSON 不进气泡）', () => {
  it('纯自然语言 → 全文为前言，无产物', () => {
    const r = splitArtifactText('你好，请告诉我你的目标');
    expect(r.prose).toBe('你好，请告诉我你的目标');
    expect(r.artifactJson).toBeNull();
  });
  it('空字符串 → 无前言无产物', () => {
    const r = splitArtifactText('');
    expect(r.prose).toBe('');
    expect(r.artifactJson).toBeNull();
  });
  it('完整 ```json 围栏 → 前言空，产物为围栏内 JSON', () => {
    const r = splitArtifactText('```json\n' + JSON_SET + '\n```');
    expect(r.prose).toBe('');
    expect(r.artifactJson).toBe(JSON_SET);
  });
  it('前言 + 围栏 → 前言保留，产物分离', () => {
    const r = splitArtifactText('信息够了，方案如下：\n```json\n' + JSON_SET + '\n```');
    expect(r.prose).toBe('信息够了，方案如下：');
    expect(r.artifactJson).toBe(JSON_SET);
  });
  it('前言 + 围栏 + 后语 → 后语不丢失，并入前言', () => {
    const r = splitArtifactText('方案如下：\n```json\n' + JSON_SET + '\n```\n两个小提醒：新手注意恢复。');
    expect(r.prose).toBe('方案如下：\n\n两个小提醒：新手注意恢复。');
    expect(r.artifactJson).toBe(JSON_SET);
  });
  it('流式半截围栏（未闭合）→ 仍判定为产物以触发生成动画', () => {
    const r = splitArtifactText('方案如下：\n```json\n{"type":"constraint_set","plan_title');
    expect(r.prose).toBe('方案如下：');
    expect(r.artifactJson).not.toBeNull();
  });
  it('刚出现 ```json 标记（body 为空）→ 判定为产物', () => {
    const r = splitArtifactText('```json');
    expect(r.artifactJson).not.toBeNull();
  });
  it('行首裸 JSON 含 type 字段 → 分离前言与产物', () => {
    const r = splitArtifactText('方案：\n' + JSON_SET);
    expect(r.prose).toBe('方案：');
    expect(r.artifactJson).toBe(JSON_SET);
  });
  it(' prose 中含花括号但非行首 JSON → 不误判', () => {
    const r = splitArtifactText('用 {key} 表示任务，比如 {math}。');
    expect(r.artifactJson).toBeNull();
  });
  it('残留 ```json（无内容）与孤立 ``` 不进 prose', () => {
    expect(splitArtifactText('已生成方案```json').prose).not.toContain('`');
    expect(splitArtifactText('已生成方案 ``` ').prose).toBe('已生成方案');
  });
  it('空引号对 ‘’/“”/"" 被清理', () => {
    const r = splitArtifactText('第一段 ‘’ 第二段 “” 第三段');
    expect(r.prose).not.toContain('‘’');
    expect(r.prose).not.toContain('“”');
    expect(r.prose).toContain('第一段');
  });
});