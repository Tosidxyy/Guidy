import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { useState } from 'react';
import { useAccount } from '../../src/auth/AuthProvider';
import { ConnectionStatus } from '../../src/components/ConnectionStatus';
import { Action, AppText, Badge, Caption, Card, Screen, SectionTitle, styles } from '../../src/components/ui';
import { useTheme, type ThemePreference } from '../../src/theme/ThemeProvider';

const preferences: { value: ThemePreference; label: string }[] = [{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }];
export default function MeScreen() {
  const { colors, preference, setPreference } = useTheme();
  const { user, pending, error, signOut, refresh } = useAccount();
  const [leaving, setLeaving] = useState(false);
  const [accountError, setAccountError] = useState('');
  async function leave() {
    if (leaving) return;
    setLeaving(true); setAccountError('');
    try { await signOut(); } catch { setAccountError('退出失败，请检查连接后重试。'); }
    finally { setLeaving(false); }
  }
  return (
    <Screen title="我的">
      <Card>
        <View style={styles.row}><View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.action, alignItems: 'center', justifyContent: 'center' }}><AppText style={{ color: colors.onAction, fontSize: 24, fontWeight: '700' }}>G</AppText></View><View style={{ flex: 1 }}><AppText style={styles.heading}>{user ? user.name || 'Guidy 用户' : '欢迎使用 Guidy'}</AppText><Caption>{pending ? '正在恢复账号…' : user ? '已登录' : '未登录'}</Caption></View></View>
        <Caption>{user ? user.email : '登录后恢复你的账号；目标和日历目前仍是演示数据。'}</Caption>
        {error || accountError ? <AppText accessibilityRole="alert">{accountError || error}</AppText> : null}
        <Action label={leaving ? '退出中…' : user ? '退出登录' : '登录'} secondary={!!user} disabled={pending || leaving} onPress={user ? leave : () => router.push('/sign-in')} />
        {error ? <Action label="重新验证账号" secondary onPress={() => { void refresh(); }} /> : null}
      </Card>
      <ConnectionStatus />
      <SectionTitle>我的内容</SectionTitle>
      <Card><View style={styles.row}><AppText style={{ flex: 1, fontWeight: '600' }}>我的模板</AppText><Badge>即将开放</Badge></View><Caption>V0.2 开放私人模板，V0.3 开放公共模板。</Caption></Card>
      <SectionTitle>外观</SectionTitle>
      <Card>
        <View accessibilityRole="radiogroup" accessibilityLabel="选择外观" style={styles.row}>{preferences.map(({ value, label }) => <Pressable key={value} onPress={() => setPreference(value)} accessibilityRole="radio" accessibilityState={{ checked: preference === value }} aria-checked={preference === value}
          style={{ minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, backgroundColor: preference === value ? colors.action : colors.subtle }}>
          <AppText style={{ color: preference === value ? colors.onAction : colors.text }}>{label}</AppText>
        </Pressable>)}</View>
        <Caption>默认跟随系统；手动选择仅在本次运行中生效。</Caption>
      </Card>
      <SectionTitle>设置</SectionTitle>
      <Card><AppText>通知与提醒</AppText><Caption>尚未申请权限 · M2 接入</Caption><View style={{ height: 1, backgroundColor: colors.divider }} /><AppText>隐私与账户</AppText><Caption>账号、隐私与数据管理在后续 M0 / M3 接入。</Caption></Card>
      <Caption>Guidy · Chat &amp; Do It. · 0.1.0</Caption>
    </Screen>
  );
}
