export class AppError extends Error {
  code: string; status: number; details?: unknown;
  constructor(code: string, status: number, details?: unknown) {
    super(code); this.code = code; this.status = status; this.details = details;
  }
}
export const MESSAGES: Record<string, string> = {
  unauthorized: '身份缺失或已失效，请刷新页面重建匿名身份',
  forbidden: '无权访问该资源',
  not_found: '资源不存在或已删除',
  validation_failed: '输入校验失败，请检查后重试',
  placement_invalid: '落点违反硬约束',
  engine_infeasible: '当前约束下无法排下全部任务',
  content_rejected: '内容审核未通过',
  artifact_invalid: 'AI 产出结构不合格，已保留上下文，请重试',
  quota_exceeded: '今天的对话额度用完了，明天再来继续规划。',
  dispatch_busy: '当前有正在生成的回复，请等待或中断后再发送',
  version_conflict: '计划已被更新，请刷新后重试',
  conflict: '请求冲突，请刷新后重试',
  engine_version_mismatch: '排程引擎版本不一致，请刷新页面',
  upstream_error: 'AI 服务暂时失败，请稍后重试',
  service_unavailable: '后端尚未就绪，请稍后重试',
  commit_conflict: '计划已被其他提交更新，请刷新后重试',
  commit_in_progress: '上一次提交仍在进行，请稍后重试',
  write_verification_failed: '保存校验失败，本次未生效，原有日程保持不变',
  payload_too_large: '消息过长，请精简后重试',
  method_not_allowed: '请求方法不被允许',
  invalid_input: '请求格式不正确',
  recovery_invalid: '恢复码无效或已被使用',
  recovery_rate_limited: '今日恢复尝试次数已用完，请明天再来',
  plan_quota_exceeded: '计划数量已达上限（20 个），删除旧计划后再新建',
  plan_not_saved: '当前还没有保存的计划，无法应用调整；请先确认并生成计划',
  conversation_plan_mismatch: '当前对话尚未关联该计划，请新建计划后再生成',
  patch_target_missing: 'AI 调整引用的任务或时间块已不存在，请刷新后重试',
  op_plan_mismatch: '这条调整指向了另一个计划，请刷新后重试',
};
export function fail(code: string, status: number, details?: unknown): never {
  throw new AppError(code, status, details);
}
export function errorEnvelope(error: unknown, diagnosticId: string) {
  const code = (error as AppError)?.code ?? 'service_unavailable';
  const known = MESSAGES[code] ? code : 'service_unavailable';
  return {
    status: (error as AppError)?.status ?? 503,
    body: { error: { code: known, message: MESSAGES[known], diagnostic_id: diagnosticId,
      ...((error as AppError)?.details !== undefined ? { details: (error as AppError).details } : {}) } },
  };
}