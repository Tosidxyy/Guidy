import { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { KeyboardAvoidingView, Platform, Pressable, TextInput, View } from 'react-native';
import { Action, AppText, Caption, Card, Screen, styles } from '../../src/components/ui';
import { useTheme } from '../../src/theme/ThemeProvider';
import { createDraft, type GoalDraft } from '../../src/goals/draft';
import { createGoal } from '../../src/goals/api';
import { useAccount } from '../../src/auth/AuthProvider';
import { deleteDraft, readDraft, saveDraft } from '../../src/goals/storage';

export default function NewGoalScreen() {
  const { user } = useAccount();
  return <NewGoalBody key={user?.id ?? 'anonymous'} signedIn={!!user} />;
}
function NewGoalBody({ signedIn }: { signedIn: boolean }) {
  const { colors } = useTheme();
  const [description, setDescription] = useState('');
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const persisted = useRef<GoalDraft | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    readDraft().then(draft => {
      if (!alive.current) return;
      setDescription(draft?.description ?? '');
      persisted.current = draft;
      setReady(true);
    }).catch(() => {
      if (alive.current) setError('无法读取本机想法，请返回后重试。原记录没有被覆盖。');
    });
    return () => { alive.current = false; };
  }, []);

  async function continueGoal(start: boolean) {
    if (!ready || busy.current) return;
    let draft: GoalDraft;
    try {
      // Retain a previously saved timeframe without asking for another field.
      draft = createDraft(description, persisted.current?.timeframe ?? '');
    } catch { setError('先写一句你想做的事。'); return; }
    const previous = persisted.current;
    draft.submissionKey = previous?.description === draft.description && previous.timeframe === draft.timeframe
      ? previous.submissionKey : undefined;
    draft.submissionKey ??= `goal_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      await saveDraft(draft);
      persisted.current = draft;
      if (!alive.current) return;
      if (!start) { router.replace('/(tabs)/goals'); return; }
      if (!signedIn) { router.push('/(tabs)/me'); return; }
      const goal = await createGoal({ description: draft.description, timeframe: draft.timeframe }, draft.submissionKey);
      if (!alive.current) return;
      // Clear only after an acknowledged save; cleanup failure replays the same key.
      await deleteDraft();
      if (alive.current) router.replace({ pathname: '/goal/[id]/chat', params: { id: goal.id } });
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '暂时未能开始，输入已保留，请重试。');
    } finally {
      busy.current = false;
      if (alive.current) setSaving(false);
    }
  }

  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <Screen title="新想法" bottomInset footer={<>
      <Action label={saving ? '正在准备…' : signedIn ? 'Guidy！' : '保存想法并登录'} disabled={!ready || saving || !description.trim()} onPress={() => void continueGoal(true)} />
      <Caption>先聊三个重要问题，再由 Guidy 制订方案。</Caption>
    </>}>
      <Pressable accessibilityRole="button" disabled={saving} onPress={() => router.replace('/(tabs)/goals')} style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}>
        <AppText>‹ 返回目标</AppText>
      </Pressable>
      <View style={{ marginVertical: 16, gap: 12 }}>
        <AppText accessibilityRole="header" style={styles.hero}>你想做成什么？</AppText>
        <Caption>一句想法就够了。时间、基础和限制，我们一起聊。</Caption>
      </View>
      <Card>
        <TextInput accessibilityLabel="我的目标" placeholder="我想学韩语，旅行时能和当地人交流…" placeholderTextColor={colors.secondary} multiline maxLength={300} editable={ready && !saving} value={description} onChangeText={setDescription} style={{ color: colors.text, fontSize: 20, lineHeight: 30, minHeight: 200, textAlignVertical: 'top' }} />
        <Caption>{description.length} / 300</Caption>
      </Card>
      {!!error && <AppText accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</AppText>}
      {!!description.trim() && <Pressable accessibilityRole="button" disabled={!ready || saving} onPress={() => void continueGoal(false)} style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}>
        <AppText style={{ color: colors.secondary }}>先保存想法，稍后继续 →</AppText>
      </Pressable>}
    </Screen>
  </KeyboardAvoidingView>;
}
