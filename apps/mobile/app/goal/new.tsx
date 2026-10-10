import { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { KeyboardAvoidingView, Platform, TextInput } from 'react-native';
import { Action, AppText, Badge, Caption, Card, Screen, styles } from '../../src/components/ui';
import { useTheme } from '../../src/theme/ThemeProvider';
import { createDraft } from '../../src/goals/draft';
import { deleteDraft, readDraft, saveDraft } from '../../src/goals/storage';

export default function NewGoalScreen() {
  const { colors } = useTheme();
  const [description, setDescription] = useState('');
  const [timeframe, setTimeframe] = useState('');
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const busy = useRef(false);
  useEffect(() => {
    let active = true;
    readDraft().then(draft => {
      if (!active) return;
      setDescription(draft?.description ?? '');
      setTimeframe(draft?.timeframe ?? '');
      setHasDraft(!!draft);
      setReady(true);
    }).catch(() => { if (active) setError('无法读取本机草稿，请返回后重试。原记录没有被覆盖。'); });
    return () => { active = false; };
  }, []);

  async function save() {
    if (!ready || busy.current) return;
    let draft;
    try { draft = createDraft(description, timeframe); }
    catch { setError('请先写下你想完成的目标。'); return; }
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      await saveDraft(draft);
      router.replace('/(tabs)/goals');
    } catch {
      setError('草稿未保存成功，你的输入仍在这里，请重试。');
    } finally { busy.current = false; setSaving(false); }
  }
  async function remove() {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    try { await deleteDraft(); router.replace('/(tabs)/goals'); }
    catch { setError('未能删除草稿，请重试。'); }
    finally { busy.current = false; setSaving(false); }
  }
  const inputStyle = { color: colors.text, backgroundColor: colors.subtle, borderRadius: 15, padding: 16, fontSize: 17, minHeight: 52 };
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen title="创建目标" bottomInset>
        <Action label="返回目标" secondary disabled={saving} onPress={() => router.replace('/(tabs)/goals')} />
        <Badge>本机草稿</Badge>
        <AppText accessibilityRole="header" style={styles.hero}>最近想完成什么？</AppText>
        <Caption>先写下想法，不必一次想清楚所有条件。</Caption>
        <Card>
          <AppText>我的目标</AppText>
          <TextInput accessibilityLabel="我的目标" placeholder="例如：我想开始学英语，能在旅行时简单交流。" placeholderTextColor={colors.secondary} multiline maxLength={300} editable={ready && !saving} value={description} onChangeText={setDescription} style={[inputStyle, { minHeight: 160, textAlignVertical: 'top' }]} />
          <Caption>{description.length} / 300</Caption>
          <AppText>期望时间（可不填）</AppText>
          <TextInput accessibilityLabel="期望时间" placeholder="例如：三个月内；暂不确定也可以" placeholderTextColor={colors.secondary} maxLength={80} editable={ready && !saving} value={timeframe} onChangeText={setTimeframe} style={inputStyle} />
        </Card>
        {!!error && <AppText accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</AppText>}
        <Action label={saving ? '正在保存…' : '保存草稿'} disabled={!ready || saving} onPress={save} />
        {hasDraft && (confirmDelete ? <Card>
          <AppText>确定删除这份本机草稿？删除后无法恢复。</AppText>
          <Action label="确认删除草稿" disabled={saving} onPress={remove} />
          <Action label="保留草稿" secondary disabled={saving} onPress={() => setConfirmDelete(false)} />
        </Card> : <Action label="删除本机草稿" secondary disabled={saving} onPress={() => setConfirmDelete(true)} />)}
        <Caption>仅保存在此设备，当前支持一份草稿。返回前请保存；再次保存会更新这份草稿。不会上传账号，也不会生成计划或安排日历。</Caption>
      </Screen>
    </KeyboardAvoidingView>
  );
}
