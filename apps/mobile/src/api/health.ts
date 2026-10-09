export type HealthErrorCode = 'not_configured' | 'invalid_url' | 'timeout' | 'unavailable' | 'invalid_response' | 'cancelled';

const messages: Record<HealthErrorCode, string> = {
  not_configured: '开发配置未完成，请设置服务地址后重新启动预览。',
  invalid_url: '服务地址配置无效，请检查开发配置。',
  timeout: '连接超时，请检查网络和服务后重试。',
  unavailable: '无法连接，请检查网络和服务后重试。',
  invalid_response: '服务返回了不符合预期的响应，请检查服务配置。',
  cancelled: '检查已取消。',
};

export class HealthCheckError extends Error {
  readonly code: HealthErrorCode;
  constructor(code: HealthErrorCode) {
    super(messages[code]);
    this.code = code;
    this.name = 'HealthCheckError';
  }
}

export type HealthResult = { version: string; requestId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const version = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/;

function healthUrl(baseUrl: string | undefined): string {
  if (!baseUrl?.trim()) throw new HealthCheckError('not_configured');
  try {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname ||
        parsed.username || parsed.password || parsed.search || parsed.hash ||
        !['', '/'].includes(parsed.pathname) || parsed.hostname === 'your_windows_lan_ip') {
      throw new Error('Invalid API origin');
    }
    return new URL('/health', parsed).toString();
  } catch {
    throw new HealthCheckError('invalid_url');
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function checkHealth({
  baseUrl = process.env.EXPO_PUBLIC_API_URL,
  signal,
  timeoutMs = 5000,
}: { baseUrl?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<HealthResult> {
  const url = healthUrl(baseUrl);
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  if (signal?.aborted) throw new HealthCheckError('cancelled');
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new HealthCheckError('unavailable');
    let payload: unknown;
    try { payload = await response.json(); } catch {
      if (controller.signal.aborted) throw new HealthCheckError(timedOut ? 'timeout' : 'cancelled');
      throw new HealthCheckError('invalid_response');
    }
    if (!object(payload) || payload.error !== null || !object(payload.data) ||
        payload.data.status !== 'ok' || payload.data.service !== 'guidy-api' ||
        typeof payload.data.version !== 'string' || !version.test(payload.data.version) ||
        typeof payload.request_id !== 'string' || !uuid.test(payload.request_id) ||
        response.headers.get('X-Request-ID') !== payload.request_id) {
      throw new HealthCheckError('invalid_response');
    }
    if (controller.signal.aborted) throw new HealthCheckError(timedOut ? 'timeout' : 'cancelled');
    return { version: payload.data.version, requestId: payload.request_id };
  } catch (error) {
    if (error instanceof HealthCheckError) throw error;
    if (controller.signal.aborted) throw new HealthCheckError(timedOut ? 'timeout' : 'cancelled');
    throw new HealthCheckError('unavailable');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
