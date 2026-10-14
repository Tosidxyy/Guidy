import { Pressable, View } from 'react-native';
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
      <Action label={draft ? '继续我的想法 →' : '＋ 开始一个新目标'} onPress={() => router.push('/goal/new')} />
      {draftError && <AppText accessibilityRole="alert">本机草稿读取失败，请进入草稿页重试。</AppText>}
      {draft && <Card>
        <Badge>待开始 · 仅此设备</Badge>
        <AppText style={{ fontWeight: '600' }}>{draft.description}</AppText>
        <Caption>继续这份想法，和 Guidy 一起聊出方案。</Caption>
      </Card>}
      {user && <>
        <SectionTitle>我的目标</SectionTitle>
        {loading && <Caption>正在读取目标…</Caption>}
        {!!listError && <Card><AppText accessibilityRole="alert">{listError}</AppText><Action label="重新读取目标" secondary onPress={() => setRetry(value => value + 1)} /></Card>}
        {accountList?.owner === user.id && <>
          {!accountList.goals.length && <Card><AppText>第一个目标，从一句想法开始。</AppText><Caption>Guidy 会提问、研究并安排方案，最后由你确认。</Caption></Card>}
          {accountList.goals.map(goal => <Card key={goal.id}>
            <Badge>{goal.status === 'draft' ? '待制订' : goal.status === 'paused' ? '已暂停' : goal.status === 'active' ? '进行中' : '已保存'}</Badge>
            <AppText style={{ fontWeight: '600' }}>{goal.description || goal.title}</AppText>
            <View style={{ height: 1, backgroundColor: colors.divider }} />
            {['draft', 'active'].includes(goal.status) && <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/goal/[id]/chat', params: { id: goal.id } })} style={{ minHeight: 44, justifyContent: 'center' }}>
              <AppText style={{ fontWeight: '600' }}>{goal.status === 'active' ? '查看方案与日程 →' : '继续 Guidy 问答 →'}</AppText>
            </Pressable>}
            <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/goal/[id]', params: { id: goal.id } })} style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}>
              <Caption>{goal.status === 'paused' ? '管理与恢复目标 →' : '管理目标'}</Caption>
            </Pressable>
          </Card>)}
          {accountList.more && <Caption>仅显示最近 100 个目标。</Caption>}
        </>}
      </>}
      {!user && <Card><AppText>让想法慢慢变成行动。</AppText><Caption>可以先保存想法，登录后开始问答。方案由你确认后才加入日历。</Caption></Card>}
    </Screen>
  );
}
