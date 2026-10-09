import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { DEMO_CODE, DEMO_EMAIL, useDemoAccount } from '../../src/auth/DemoAccountProvider';
import { demoExpired, demoSendGate, issueDemoChallenge, DEMO_WINDOW_MS, type DemoChallenge } from '../../src/auth/demoChallenge';
import { Action, AppText, Badge, Caption, Card, Screen, styles } from '../../src/components/ui';
import { useTheme } from '../../src/theme/ThemeProvider';

type Stage = 'email' | 'code';
export default function SignInScreen() {
  const { colors } = useTheme();
  const { enterDemo } = useDemoAccount();
  const [email, setEmail] = useState(DEMO_EMAIL);
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<Stage>('email');
  const [operation, setOperation] = useState<'issue' | 'verify' | null>(null);
  const busy = operation !== null;
  const [error, setError] = useState('');
  const [challenge, setChallenge] = useState<DemoChallenge | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [now, setNow] = useState(Date.now);
  const [failNext, setFailNext] = useState(false);
  const [showScenarios, setShowScenarios] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codeInput = useRef<TextInput>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const gate = demoSendGate(history, now);
  const expired = stage === 'code' && demoExpired(challenge, now);

  function showCode() {
    const timestamp = Date.now();
    setHistory((values) => [...values.filter((time) => time > timestamp - DEMO_WINDOW_MS), timestamp]);
    setChallenge(issueDemoChallenge(timestamp));
    setNow(timestamp);
    setStage('code');
    setCode('');
    setError('');
  }

  function resend() {
    if (timer.current) return;
    const currentGate = demoSendGate(history, Date.now());
    if (currentGate.reason) {
      setError('');
      return;
    }
    setError('');
    finishPreviewStep(showCode, 'issue');
  }

  function finishPreviewStep(callback: () => void, kind: 'issue' | 'verify' = 'verify') {
    if (timer.current) return;
    Keyboard.dismiss();
    setOperation(kind);
    // Deliberate mock loading state; no request, email or backend operation occurs.
    timer.current = setTimeout(() => {
      timer.current = null;
      setOperation(null);
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
      resend();
      return;
    }
    if (demoExpired(challenge, Date.now())) {
      setError('演示验证码已过期，请重新获取。');
      setNow(Date.now());
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
    finishPreviewStep(() => {
      if (demoExpired(challenge, Date.now())) { setError('演示验证码已过期，请重新获取。'); setNow(Date.now()); return; }
      if (failNext) { setFailNext(false); setError('模拟验证失败。输入已保留，请再次重试。'); return; }
      enterDemo(); router.dismissTo('/me');
    });
  }

  function back() {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setOperation(null);
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
            <Caption>{expired ? '演示验证码已过期，请重新获取。' : `演示有效期剩余 ${Math.max(0, Math.ceil(((challenge?.expiresAt ?? now) - now) / 1000))} 秒。`}</Caption>
          </> : <Caption>使用上方演示邮箱体验流程。</Caption>}
          {error && !expired ? <AppText accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</AppText> : null}
          <Action label={busy ? (operation === 'issue' ? '准备中…' : '验证中…') : (stage === 'email' ? '显示演示验证码' : expired ? '验证码已过期' : '进入演示账号')}
            onPress={submit} disabled={busy || expired || (stage === 'email' && gate.reason !== null)} />
          {gate.reason ? <Caption>{gate.reason === 'limited' ? '演示重发频率受限' : '演示重发冷却中'} · {gate.waitSeconds} 秒后可重试</Caption> : null}
          {stage === 'code' ? <>
            <Action label={busy ? '请稍候…' : gate.reason ? `重新获取（${gate.waitSeconds}s）` : '重新获取演示验证码'} secondary disabled={busy || gate.reason !== null} onPress={resend} />
            {failNext ? <Caption>下一次正确验证码提交将模拟失败，然后可正常重试。</Caption> : null}
            <Action label="修改邮箱" secondary disabled={busy} onPress={() => { setStage('email'); setCode(''); setError(''); setFailNext(false); setShowScenarios(false); }} />
          </> : null}
        </Card>
        {stage === 'code' ? <Card>
          <Action label={showScenarios ? '收起异常演示' : '展开异常演示'} secondary disabled={busy} onPress={() => setShowScenarios((value) => !value)} />
          {showScenarios ? <>
            <Caption>下列操作只切换前端演示状态。模拟时长不是正式登录规则。</Caption>
            <Action label="演示验证码过期" secondary disabled={busy} onPress={() => { setChallenge({ expiresAt: Date.now() }); setNow(Date.now()); setError('演示验证码已过期，请重新获取。'); }} />
            <Action label="演示重发限流" secondary disabled={busy} onPress={() => { const timestamp = Date.now(); setHistory([timestamp, timestamp, timestamp]); setNow(timestamp); setError(''); }} />
            <Action label="演示下一次验证失败" secondary disabled={busy || expired} onPress={() => { setFailNext(true); setError(''); }} />
          </> : null}
        </Card> : null}
        <Caption>仅用于界面预览，不调用认证接口，不保存凭据。完全重载后，演示账号状态重置。</Caption>
        <Action label="返回我的" secondary onPress={back} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
