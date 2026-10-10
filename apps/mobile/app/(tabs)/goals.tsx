import { View } from 'react-native';
import { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import type { GoalDraft } from '../../src/goals/draft';
import { readDraft } from '../../src/goals/storage';
import { listGoals, type AccountGoal } from '../../src/goals/api';
import { useAccount } from '../../src/auth/AuthProvider';
import { Action, AppText, Badge, Caption, Card, Screen, SectionTitle, styles } from '../../src/components/ui';
import { useTheme } from '../../src/theme/ThemeProvider';

export default function GoalsScreen() {
  const { colors } = useTheme();
  const [draft, setDraft] = useState<GoalDraft | null>(null);
  const [draftError, setDraftError] = useState(false);
  const { user } = useAccount();
  const owner = user?.id;
  const [accountList, setAccountList] = useState<{ owner: string; goals: AccountGoal[]; more: boolean } | null>(null);
  const [listError, setListError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useFocusEffect(useCallback(() => {
    void retry; // A manual refresh restarts this focused request.
    const controller = new AbortController();
    setAccountList(null);
    setListError('');
    setLoading(!!owner);
    if (owner) listGoals(controller.signal).then(result => {
      if (!controller.signal.aborted) setAccountList({ owner, goals: result.goals, more: result.has_more });
    }).catch(error => {
      if (!controller.signal.aborted) setListError(error instanceof Error ? error.message : '目标读取失败。');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [owner, retry]));
  useFocusEffect(useCallback(() => {
    let active = true;
    readDraft().then(value => { if (active) { setDraft(value); setDraftError(false); } }).catch(() => { if (active) { setDraft(null); setDraftError(true); } });
    return () => { active = false; };
  }, []));
  return (
    <Screen title="Guidy">
      <View><AppText accessibilityRole="header" style={styles.hero}>今天，向前一点。</AppText><Caption>有想法，就让它发生。Chat &amp; Do It.</Caption></View>
      <Action label={draft ? '继续编辑本机草稿' : '＋ 创建目标草稿'} onPress={() => router.push('/goal/new')} />
      {draftError && <AppText accessibilityRole="alert">本机草稿读取失败，请进入草稿页重试。</AppText>}
      {draft && <Card>
        <Badge>草稿 · 仅此设备</Badge>
        <AppText style={{ fontWeight: '600' }}>{draft.description}</AppText>
        <Caption>期望时间：{draft.timeframe || '暂不确定'}</Caption>
        <Caption>下一步 · 继续补充目标，登录后可保存到账号。AI 澄清尚未接入。</Caption>
      </Card>}
      {user && <>
        <SectionTitle>账号目标</SectionTitle>
        {loading && <Caption>正在读取目标…</Caption>}
        {!!listError && <Card><AppText accessibilityRole="alert">{listError}</AppText><Action label="重新读取目标" secondary onPress={() => setRetry(value => value + 1)} /></Card>}
        {accountList?.owner === user.id && <>
          {!accountList.goals.length && <Caption>还没有账号目标。可以先写下草稿，再保存到账号。</Caption>}
          {accountList.goals.map(goal => <Card key={goal.id}>
            <Badge>{goal.status === 'draft' ? '草稿 · 待澄清' : '已保存'}</Badge>
            <AppText style={{ fontWeight: '600' }}>{goal.description || goal.title}</AppText>
            <Caption>期望时间：{goal.timeframe_note || '暂不确定'}</Caption>
            <Caption>下一步 · 等待接入目标内澄清对话。</Caption>
          </Card>)}
          {accountList.more && <Caption>仅显示最近 100 个目标。</Caption>}
        </>}
      </>}
      <Caption>M0 界面预览 · 下方为演示数据，不是实际计划或执行记录。</Caption>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Card style={{ flex: 1 }}><Caption>今日待办 · 演示</Caption><AppText style={styles.hero}>2</AppText></Card>
        <Card style={{ flex: 1 }}><Caption>待确认计划 · 演示</Caption><AppText style={styles.hero}>1</AppText></Card>
      </View>
      <SectionTitle>我的目标</SectionTitle>
      <Card>
        <View style={styles.row}><AppText style={{ fontWeight: '600', flex: 1 }}>建立健身习惯</AppText><Badge>进行中 · 演示</Badge></View>
        <View style={{ height: 1, backgroundColor: colors.divider }} />
        <Caption>本周已完成 2 / 3 项 · 演示</Caption>
        <View accessibilityLabel="演示完成进度：三项中完成两项" style={{ height: 6, borderRadius: 3, backgroundColor: colors.subtle }}>
          <View style={{ width: '66.67%', height: 6, borderRadius: 3, backgroundColor: colors.text }} />
        </View>
        <AppText>下一步 · 今天 18:30 全身训练</AppText>
      </Card>
      <Card>
        <View style={styles.row}><AppText style={{ fontWeight: '600', flex: 1 }}>准备英语考试</AppText><Badge>待确认 · 演示</Badge></View>
        <Caption>计划草稿已生成，等待你确认日程。</Caption>
        <AppText>计划与对话将在 M1 接入</AppText>
      </Card>
    </Screen>
  );
}
