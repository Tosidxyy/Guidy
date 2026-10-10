import { Platform } from 'react-native';
import { apiOrigin, authClient } from '../auth/client';

export type AccountGoal = { id: string; title: string; description: string; timeframe_note: string; status: string; revision: number };
async function request(method: 'GET' | 'POST', body?: { description: string; timeframe: string }, key?: string, signal?: AbortSignal) {
  if (!apiOrigin || !authClient) throw new Error('请先配置服务地址。');
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  if (Platform.OS !== 'web') { headers.Cookie = await authClient.getCookie(); headers['expo-origin'] = 'guidy://'; }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(cancel, 10_000);
  try {
    const response = await fetch(`${apiOrigin}/api/v1/goals`, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: Platform.OS === 'web' ? 'include' : 'omit', signal: controller.signal });
    const payload = await response.json();
    if (!response.ok) {
      if (response.status === 401) throw new Error('登录已失效，请重新登录。本机草稿仍保留。');
      if (response.status === 409) throw new Error('提交内容已改变，请先保存本机草稿，再重新提交。');
      throw new Error('账号目标未保存或读取成功，请稍后重试。');
    }
    if (payload.error !== null || !payload.data) throw new Error('服务响应格式不正确。');
    return payload.data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('连接超时或已取消。本机草稿仍保留，请重试。');
    if (error instanceof Error && !['TypeError'].includes(error.name)) throw error;
    throw new Error('无法连接服务。本机草稿仍保留，请重试。');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
export async function listGoals(signal: AbortSignal): Promise<{ goals: AccountGoal[]; has_more: boolean }> {
  const result = await request('GET', undefined, undefined, signal);
  if (!Array.isArray(result.goals) || typeof result.has_more !== 'boolean' || result.goals.some((g: AccountGoal) => !g || typeof g.id !== 'string' || typeof g.description !== 'string' || typeof g.title !== 'string' || typeof g.timeframe_note !== 'string' || typeof g.status !== 'string' || !Number.isInteger(g.revision))) throw new Error('目标列表格式不正确。');
  return result;
}
export async function createGoal(body: { description: string; timeframe: string }, key: string): Promise<AccountGoal> {
  const result = await request('POST', body, key);
  if (typeof result.id !== 'string' || result.status !== 'draft' || result.description !== body.description || result.timeframe_note !== body.timeframe || !Number.isInteger(result.revision)) throw new Error('目标保存结果未确认。本机草稿仍保留，请重试。');
  return result;
}
