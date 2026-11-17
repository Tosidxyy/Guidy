import { describe, expect, it } from 'vitest';
import { RESEARCH_TOOLS } from '../qca/tools';
describe('RESEARCH_TOOLS — 最小只读研究工具白名单', () => {
  it('恰有一个 agent_toolset_20260401 条目', () => {
    expect(RESEARCH_TOOLS).toHaveLength(1);
    expect(RESEARCH_TOOLS[0].type).toBe('agent_toolset_20260401');
  });
  it('enabled_tools 恰为 WebSearch + WebFetch（无危险工具）', () => {
    expect(RESEARCH_TOOLS[0].enabled_tools).toEqual(['WebSearch', 'WebFetch']);
  });
  it('两者 permission_policy 均为 always_allow', () => {
    const configs = RESEARCH_TOOLS[0].configs;
    const byName = Object.fromEntries(configs.map((c: any) => [c.name, c.permission_policy.type]));
    expect(byName.WebSearch).toBe('always_allow');
    expect(byName.WebFetch).toBe('always_allow');
  });
});