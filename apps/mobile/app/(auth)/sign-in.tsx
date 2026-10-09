import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { DEMO_CODE, DEMO_EMAIL, useDemoAccount } from '../../src/auth/DemoAccountProvider';
import { Action, AppText, Badge, Caption, Card, Screen, styles } from '../../src/components/ui';
import { useTheme } from '../../src/theme/ThemeProvider';

type Stage = 'email' | 'code';
export default function SignInScreen() {
  const { colors } = useTheme();
  const { enterDemo } = useDemoAccount();
  const [email, setEmail] = useState(DEMO_EMAIL);
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<Stage>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codeInput = useRef<TextInput>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function finishPreviewStep(callback: () => void) {
    if (timer.current) return;
    Keyboard.dismiss();
    setBusy(true);
    // Deliberate mock loading state; no request, email or backend operation occurs.
    timer.current = setTimeout(() => {
      timer.current = null;
      setBusy(false);
      callback();
    }, 500);
  }

  function submit() {
    if (timer.current) return;
    setError('');
    if (stage === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        setError('请输入有效的邮箱地址。');
        return;
      }
      if (email.trim().toLowerCase() !== DEMO_EMAIL) {
        setError('此预览仅支持演示邮箱 demo@example.invalid。');
        return;
      }
      finishPreviewStep(() => { setStage('code'); setCode(''); });
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setError('请输入 6 位数字验证码。');
      codeInput.current?.focus();
      return;
    }
    if (code !== DEMO_CODE) {
      setError('演示验证码不正确，请输入 123456。');
      return;
    }
    finishPreviewStep(() => { enterDemo(); router.dismissTo('/me'); });
  }

  function back() {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setBusy(false);
    Keyboard.dismiss();
    router.dismissTo('/me');
  }

  const inputStyle = {
    minHeight: 52, paddingHorizontal: 16, paddingVertical: 12, borderWidth: 1,
    borderRadius: 12, borderColor: colors.divider, backgroundColor: colors.surface,
    color: colors.text, fontSize: 16,
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen title="Guidy" bottomInset>
        <View><AppText accessibilityRole="header" style={styles.hero}>把想法变成行动。</AppText><Caption>Chat &amp; Do It.</Caption></View>
        <Caption>提出目标 → 确认计划 → 按时执行</Caption>
        <Badge>UI 演示 · 未连接认证后端</Badge>
        <Card>
          <AppText accessibilityRole="header" style={styles.heading}>{stage === 'email' ? '邮箱登录' : '输入演示验证码'}</AppText>
          <AppText>邮箱</AppText>
          <TextInput accessibilityLabel="邮箱" value={email} onChangeText={(value) => { setEmail(value); setError(''); }}
            editable={!busy && stage === 'email'} keyboardType="email-address" autoCapitalize="none" autoCorrect={false}
            autoComplete="off" maxLength={254} returnKeyType="next" onSubmitEditing={submit}
            placeholder="demo@example.invalid" placeholderTextColor={colors.secondary} style={inputStyle} />
          {stage === 'code' ? <>
            <AppText>验证码</AppText>
            <TextInput ref={codeInput} accessibilityLabel="验证码" value={code} onChangeText={(value) => { setCode(value); setError(''); }}
              editable={!busy} keyboardType="number-pad" autoComplete="off" maxLength={6} returnKeyType="done"
              onSubmitEditing={submit} placeholder="6 位数字" placeholderTextColor={colors.secondary} style={inputStyle} />
            <Caption>演示验证码：123456。没有发送邮件。</Caption>
          </> : <Caption>使用上方演示邮箱体验流程。</Caption>}
          {error ? <AppText accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</AppText> : null}
          <Action label={busy ? (stage === 'email' ? '准备中…' : '验证中…') : (stage === 'email' ? '显示演示验证码' : '进入演示账号')}
            onPress={submit} disabled={busy} />
          {stage === 'code' ? <Action label="修改邮箱" secondary disabled={busy} onPress={() => { setStage('email'); setCode(''); setError(''); }} /> : null}
        </Card>
        <Caption>仅用于界面预览，不调用认证接口，不保存凭据。完全重载后，演示账号状态重置。</Caption>
        <Action label="返回我的" secondary onPress={back} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
