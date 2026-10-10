import { useCallback, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { KeyboardAvoidingView, Platform, TextInput } from 'react-native';
import { Action, AppText, Badge, Caption, Card, Screen } from '../../src/components/ui';
import { useTheme } from '../../src/theme/ThemeProvider';
import { useAccount } from '../../src/auth/AuthProvider';
import { getConditions, GoalApiError, updateGoal, type AccountGoal } from '../../src/goals/api';
import { questions, type SavedSlot } from '../../src/goals/clarification';

export default function GoalDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, pending } = useAccount();
  const owner = user?.id;
  const { colors } = useTheme();
  const [record, setRecord] = useState<{owner: string; goal: AccountGoal; slots: SavedSlot[]} | null>(null);
  const [description, setDescription] = useState('');
  const [timeframe, setTimeframe] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [discard, setDiscard] = useState(false);
  const preserve = useRef(false);
  const busy = useRef(false);
  const operation = useRef<{payload: string; key: string} | null>(null);
  const generation = useRef(0);
  const goal = record?.owner === owner && record?.goal.id === id ? record.goal : null;

  useFocusEffect(useCallback(() => {
    void refresh;
    const current = ++generation.current;
    const controller = new AbortController();
    setError('');
    setNotice('');
    setLoading(!!owner);
    setRecord(null);
    if (owner) getConditions(id, controller.signal).then(result => {
      const value = result.goal;
      if (controller.signal.aborted) return;
      setRecord({owner,goal:value,slots:result.slots});
      if (!preserve.current) { setDescription(value.description || value.title); setTimeframe(value.timeframe_note); }
      else setNotice('已读取最新版本，保留了你的输入。请核对后再保存。');
      preserve.current = false;
      operation.current = null;
      setConflict(false);
    }).catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '无法读取目标。'); })
      .finally(() => { if (generation.current === current && !controller.signal.aborted) setLoading(false); });
    const invalidate = () => { generation.current++; };
    return () => { controller.abort(); invalidate(); };
  }, [id, owner, refresh]));

  async function save(status: 'draft' | 'paused') {
    if (!goal || busy.current || loading || conflict) return;
    const text = description.trim();
    if (!text || text.length > 300 || timeframe.trim().length > 80) { setError('请填写目标（最多 300 字），期望时间最多 80 字。'); return; }
    const body = {description:text,timeframe:timeframe.trim(),status,expected_revision:goal.revision};
    const payload = JSON.stringify(body);
    if (operation.current?.payload !== payload) operation.current = {payload,key:`edit_${Date.now()}_${Math.random().toString(36).slice(2,12)}`};
    const current = generation.current;
    busy.current = true;
    setSaving(true); setError(''); setNotice('');
    try {
      const result = await updateGoal(goal.id,body,operation.current.key);
      if (current !== generation.current) return;
      setRecord(previous => ({owner:owner!,goal:result,slots:previous && previous.owner === owner ? previous.slots : []})); setDescription(result.description); setTimeframe(result.timeframe_note);
      setNotice(status === 'paused' ? '目标已暂停。' : goal.status === 'paused' ? '目标已恢复为待澄清草稿。' : '修改已保存。');
      operation.current = null;
    } catch(err) {
      if (current !== generation.current) return;
      setError(err instanceof Error ? err.message : '保存失败，你的输入仍保留。');
      if (err instanceof GoalApiError) setConflict(true);
    } finally { busy.current = false; setSaving(false); }
  }
  const editable = !!goal && ['draft','paused'].includes(goal.status);
  const dirty = !!goal && (description !== (goal.description || goal.title) || timeframe !== goal.timeframe_note);
  function back() { if (dirty) setDiscard(true); else router.replace('/(tabs)/goals'); }
  const inputStyle = {backgroundColor:colors.subtle,color:colors.text,borderRadius:15,padding:16,fontSize:17,minHeight:52};
  return <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <Screen title="目标详情" bottomInset>
      <Action label="返回目标" secondary disabled={saving} onPress={back} />
      {discard && <Card><AppText>放弃尚未保存的修改？</AppText><Action label="放弃修改并返回" onPress={() => router.replace('/(tabs)/goals')} /><Action label="继续编辑" secondary onPress={() => setDiscard(false)} /></Card>}
      {!owner && <Caption>{pending ? '正在恢复账号…' : '请先在「我的」登录后查看账号目标。'}</Caption>}
      {loading && <Caption>正在读取目标…</Caption>}
      {!!error && <AppText accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</AppText>}
      {!!notice && <AppText accessibilityLiveRegion="polite">{notice}</AppText>}
      {owner && !loading && (conflict || !goal) && <Action label={conflict ? '读取最新版本（保留输入）' : '重新读取目标'} secondary disabled={saving} onPress={() => { preserve.current = conflict; setRefresh(n => n+1); }} />}
      {goal && <>
        <Badge>{goal.status === 'paused' ? '已暂停' : goal.status === 'draft' ? '草稿 · 待澄清' : '当前状态暂不可编辑'}</Badge>
        <Card>
          <AppText>我的目标</AppText>
          <TextInput accessibilityLabel="账号目标内容" multiline maxLength={300} value={description} onChangeText={setDescription} editable={editable && !saving && !loading} style={[inputStyle,{minHeight:160,textAlignVertical:'top'}]} />
          <Caption>{description.length} / 300</Caption>
          <AppText>期望时间（可不填）</AppText>
          <TextInput accessibilityLabel="账号期望时间" maxLength={80} value={timeframe} onChangeText={setTimeframe} editable={editable && !saving && !loading} style={inputStyle} />
        </Card>
        {!!record?.slots.length && <Card>
          <AppText>已保存的条件 · 来自你</AppText>
          {questions.map(item => { const saved = record.slots.find(s => s.key === item.key); return <AppText key={item.key}>{item.label}：{saved?.value.state === 'confirmed' ? saved.value.text : '暂不确定'}</AppText>; })}
        </Card>}
        {editable && <>
          <Action label="澄清目标与条件" secondary disabled={saving || loading || conflict || dirty} onPress={() => router.push({ pathname: '/goal/[id]/clarify', params: { id } })} />
          <Action label={saving ? '正在保存…' : '保存修改'} disabled={saving || loading || conflict} onPress={() => save(goal.status as 'draft' | 'paused')} />
          <Action label={goal.status === 'paused' ? '继续目标' : '暂停目标'} secondary disabled={saving || loading || conflict || dirty} onPress={() => save(goal.status === 'paused' ? 'draft' : 'paused')} />
          {dirty && <Caption>内容有修改，请先保存，再暂停或继续。</Caption>}
        </>}
        <Caption>离开前请保存修改。AI 澄清尚未接入，暂停不会操作日历或通知。</Caption>
      </>}
    </Screen>
  </KeyboardAvoidingView>;
}
