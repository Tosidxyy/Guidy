import { createAuthClient } from 'better-auth/react';
import { emailOTPClient } from 'better-auth/client/plugins';
import { expoClient } from '@better-auth/expo/client';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

function configuredOrigin(): string | null {
  try {
    const url = new URL(process.env.EXPO_PUBLIC_API_URL ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname === 'your_windows_lan_ip' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return url.origin;
  } catch { return null; }
}
const origin = configuredOrigin();
export const apiOrigin = origin;
export const authClient = origin ? createAuthClient({
  baseURL: `${origin}/api/auth`,
  plugins: [emailOTPClient(), expoClient({ scheme: 'guidy', storagePrefix: `guidy_${origin.replace(/[^a-zA-Z0-9]/g, '_')}`, storage: SecureStore, disableCache: true })],
  fetchOptions: { timeout: 10_000 },
}) : null;

export async function signOutConfirmed() {
  if (!authClient || !origin) throw new Error('Auth not configured');
  // The native plugin clears local cookies before signOut. Revoke first so an
  // offline failure retains the credential for a later retry.
  if (Platform.OS !== 'web') {
    const cookie = await authClient.getCookie();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${origin}/api/auth/sign-out`, { method: 'POST', credentials: 'omit', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'expo-origin': 'guidy://', cookie }, body: '{}' });
      if (!response.ok) throw new Error('Sign out not confirmed');
    } finally { clearTimeout(timer); }
    // Server revocation is confirmed. The SDK clears secure local cookie state.
    await authClient.signOut();
    return;
  }
  const result = await authClient.signOut();
  if (result.error) throw new Error('Sign out not confirmed');
}

export function authMessage(code: string | undefined): string {
  if (code === 'INVALID_ORIGIN') return '开发预览的登录来源未获允许，请更新后端预览配置后重试。';
  if (code === 'EMAIL_PROVIDER_AUTH_FAILED') return '邮件服务凭据无效，请先更新服务端发信配置。';
  if (code === 'EMAIL_PROVIDER_REJECTED') return '邮件服务拒绝发送，请检查测试邮箱、发信权限和域名配置。';
  if (code === 'EMAIL_PROVIDER_RATE_LIMITED') return '邮件发送过于频繁，请稍后重试。';
  if (code === 'EMAIL_PROVIDER_INVALID_REQUEST' || code === 'EMAIL_PROVIDER_INVALID_RESPONSE') return '邮件服务配置或响应不正确，请检查服务端发信配置。';
  if (code === 'EMAIL_PROVIDER_RUNTIME_ERROR') return '邮件发送运行异常，请更新服务端后重试。';
  if (code === 'EMAIL_PROVIDER_UNAVAILABLE' || code === 'EMAIL_PROVIDER_TIMEOUT') return '邮件服务暂时不可用，请稍后重试。';
  if (code === 'OTP_DELIVERY_FAILED') return '验证码邮件发送失败，请稍后重试。';
  if (code === 'TEST_RECIPIENT_ONLY') return '当前服务仅支持已配置的测试收件邮箱。';
  if (code?.includes('EXPIRED')) return '验证码已过期，请重新获取。';
  if (code?.includes('ATTEMPTS') || code?.includes('TOO_MANY')) return '尝试过于频繁，请稍后重新获取。';
  if (code?.includes('INVALID_OTP') || code?.includes('INVALID_CODE')) return '验证码不正确，请检查后重试。';
  if (code === 'AUTH_NOT_CONFIGURED') return '认证服务尚未配置，请先完成本地开发配置。';
  return '操作失败，请检查连接或重新获取验证码。';
}
