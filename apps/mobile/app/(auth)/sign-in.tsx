import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, TextInput } from 'react-native';
import { authClient, authMessage } from '../../src/auth/client';
import { normalizeDemoCode } from '../../src/auth/demoInput';
import { Action, AppText, Badge, Caption, Card, Screen } from '../../src/components/ui';
import { useTheme } from '../../src/theme/ThemeProvider';

export default function SignInScreen() {
  const { colors } = useTheme();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [delivery, setDelivery] = useState<'local-inbox' | 'email' | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState('');
  const codeInput = useRef<TextInput>(null);
  const emailInput = useRef<TextInput>(null);
  async function submit(resend = false) {
    if (lock.current) return;
    const address = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) { setError('请输入有效邮箱。'); emailInput.current?.focus(); return; }
    if (!authClient) { setError('请配置服务地址后重启 App。'); return; }
    if (stage === 'code' && !resend && !/^\d{6}$/.test(code)) { setError('请输入 6 位数字验证码。'); codeInput.current?.focus(); return; }
    lock.current = true; setBusy(true); setError(''); Keyboard.dismiss();
    try {
      if (stage === 'email' || resend) {
        const result = await authClient.emailOtp.sendVerificationOtp({ email: address, type: 'sign-in' });
        if (result.error) { setError(authMessage(result.error.code)); return; }
        const method = (result.data as { delivery?: string } | null)?.delivery;
        if (method !== 'email' && method !== 'local-inbox') { setError('服务投递信息不完整，请更新服务后重试。'); return; }
        setDelivery(method);
        setEmail(address); setCode(''); setStage('code');
      } else {
        const result = await authClient.signIn.emailOtp({ email: address, otp: code });
        if (result.error) { setError(authMessage(result.error.code)); return; }
        router.dismissTo('/me');
      }
    } catch { setError('无法连接认证服务，请检查连接后重试。'); }
    finally { lock.current = false; setBusy(false); }
  }
  const inputStyle = { minHeight: 52, borderWidth: error ? 2 : 1, borderColor: error ? colors.text : colors.divider, borderRadius: 12, paddingHorizontal: 14, color: colors.text, backgroundColor: colors.subtle, fontSize: 17 };
  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.background }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <Screen title="登录 Guidy">
      <Badge>{delivery === 'local-inbox' ? '本地开发认证' : '邮箱验证码登录'}</Badge>
      <Card>
        <AppText style={{ fontSize: 24, fontWeight: '700' }}>用邮箱继续</AppText>
        <Caption>通过验证码继续使用 Guidy。账号由服务端验证，投递方式将在获取验证码后显示。</Caption>
        <AppText>邮箱</AppText>
        <TextInput ref={emailInput} accessibilityLabel="邮箱" value={email} onChangeText={value => { setEmail(value); setError(''); }} editable={!busy && stage === 'email'} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} maxLength={254} placeholder="you@example.com" placeholderTextColor={colors.secondary} style={inputStyle} returnKeyType="next" onSubmitEditing={() => { void submit(); }} />
        {stage === 'code' ? <>
          <AppText>验证码</AppText>
          <TextInput ref={codeInput} accessibilityLabel="验证码" accessibilityHint={error || '输入六位登录验证码。'} value={code} onChangeText={value => { setCode(normalizeDemoCode(value)); setError(''); }} editable={!busy} keyboardType="number-pad" autoFocus autoComplete="one-time-code" maxLength={32} placeholder="6 位数字" placeholderTextColor={colors.secondary} style={inputStyle} onSubmitEditing={() => { void submit(); }} />
          <Caption>{delivery === 'email' ? '验证码已提交发送，请检查邮箱及垃圾邮件。有效期 5 分钟。' : '在 Windows 后端目录运行 npm run auth:inbox -- 你的邮箱 获取验证码，有效期 5 分钟。'}</Caption>
        </> : null}
        {error ? <AppText accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</AppText> : null}
        <Action label={busy ? '处理中…' : stage === 'email' ? '获取验证码' : '登录'} disabled={busy} onPress={() => { void submit(); }} />
        {stage === 'code' ? <>
          <Action label="重新获取验证码" secondary disabled={busy} onPress={() => { void submit(true); }} />
          <Action label="修改邮箱" secondary disabled={busy} onPress={() => { setStage('email'); setCode(''); setError(''); }} />
        </> : null}
      </Card>
      {delivery === 'local-inbox' ? <Caption>本地开发收件箱没有发送真实邮件。</Caption> : null}
      <Action label="返回我的" secondary disabled={busy} onPress={() => router.dismissTo('/me')} />
    </Screen>
  </KeyboardAvoidingView>;
}
