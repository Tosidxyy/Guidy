// 本机模式：计划/日历/会话/画像全部读写 IndexedDB；网络只用于 AI 代理与一次性迁移。
import { ApiError } from '@/lib/apiError';
import {
  localApplyPatch, localCalendar, localCommit, localConversations, localDeleteAll, localDeletePlan,
  localGetProfile, localHistory, localLearnProfile, localMarkProgress, localMe, localPlan, localPlans,
  localSaveDraft, localSaveProfile, localSharedOps,
} from '@/lib/local/domain';

export { ApiError };

const BASE = '/functions/v1/app/api';
/** 无状态 AI 代理：密钥只在 Function 内使用，服务端不落库。 */
export const SEND_URL = `${BASE}/ai/chat`;
export const EVENTS_URL = (id: string, cursor: string) => `${BASE}/chat/events?conversation_id=${encodeURIComponent(id)}&cursor=${encodeURIComponent(cursor)}`;
export const LEGACY_BASE = BASE;

export const api = {
  me: () => localMe(),
  conversations: () => localConversations(),
  history: (id: string) => localHistory(id),
  plans: () => localPlans(),
  calendar: () => localCalendar(),
  sharedBlocks: (body: unknown) => localSharedOps(body),
  plan: (id: string) => localPlan(id),
  commit: (body: unknown) => localCommit(body),
  applyPatch: (body: unknown) => localApplyPatch(body),
  deletePlan: (id: string) => localDeletePlan(id),
  interrupt: async () => ({ ok: true }),
  recoveryGenerate: async (): Promise<{ code: string }> => { throw new ApiError('not_supported', 409, '本地模式不支持恢复码，换设备请使用数据导出'); },
  recoveryClaim: async (_code: string): Promise<{ ok: boolean; plans_count: number; conversations_count: number }> => { throw new ApiError('not_supported', 409, '本地模式不支持恢复码，换设备请使用数据导出'); },
  saveDraft: (body: unknown) => localSaveDraft(body),
  profile: () => localGetProfile(),
  saveProfile: (habits: string) => localSaveProfile(habits),
  learnProfile: () => localLearnProfile(),
  deleteAll: () => localDeleteAll(),
  markProgress: (blockId: string, status: string, actualDurationMin?: number | null) => localMarkProgress(blockId, status, actualDurationMin),
};