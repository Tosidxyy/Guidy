// 服务端固定的最小只读研究工具白名单。危险工具对模型完全不可见。
// 只读检索工具设 always_allow：平台直接执行，不暂停（Guidy 不实现工具确认回传链路）。
export const RESEARCH_TOOLS = [
  {
    type: 'agent_toolset_20260401',
    enabled_tools: ['WebSearch', 'WebFetch'],
    configs: [
      { name: 'WebSearch', permission_policy: { type: 'always_allow' } },
      { name: 'WebFetch', permission_policy: { type: 'always_allow' } },
    ],
  },
];