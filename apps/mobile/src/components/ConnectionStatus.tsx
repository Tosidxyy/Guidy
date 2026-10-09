import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { checkHealth, HealthCheckError } from '../api/health';
import { useTheme } from '../theme/ThemeProvider';
import { Action, AppText, Caption, Card, SectionTitle, styles } from './ui';

type Status = { kind: 'idle' | 'loading' } | { kind: 'ready'; version: string } | { kind: 'error'; message: string };

export function ConnectionStatus() {
  const { colors } = useTheme();
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [lastSuccess, setLastSuccess] = useState<Date | null>(null);
  const active = useRef<AbortController | null>(null);

  useEffect(() => () => active.current?.abort(), []);

  async function check() {
    if (active.current) return;
    const request = new AbortController();
    active.current = request;
    setStatus({ kind: 'loading' });
    try {
      const result = await checkHealth({ signal: request.signal });
      if (!request.signal.aborted) {
        setStatus({ kind: 'ready', version: result.version });
        setLastSuccess(new Date());
      }
    } catch (error) {
      if (!request.signal.aborted) setStatus({ kind: 'error', message: error instanceof HealthCheckError ? error.message : '检查失败，请重试。' });
    } finally {
      if (active.current === request) active.current = null;
    }
  }

  return <>
    <SectionTitle>连接状态</SectionTitle>
    <Card>
      <View accessibilityLiveRegion="polite" style={styles.row}>
        {status.kind === 'loading' ? <ActivityIndicator color={colors.text} accessibilityLabel="正在检查服务" /> : null}
        <AppText style={{ fontWeight: '600' }}>{status.kind === 'ready' ? '服务可用' : status.kind === 'loading' ? '正在检查…' : status.kind === 'error' ? '连接失败' : '尚未检查'}</AppText>
      </View>
      {status.kind === 'ready' ? <Caption>已连接 Guidy 服务 · 版本 {status.version}</Caption> : status.kind === 'error' ? <Caption>{status.message}</Caption> : <Caption>检查是否可以连接服务；检查成功不代表已经登录。</Caption>}
      {lastSuccess ? <Caption>最近成功检查：{lastSuccess.toLocaleTimeString('zh-CN')}</Caption> : null}
      <Action label={status.kind === 'loading' ? '检查中…' : status.kind === 'idle' ? '检查连接' : '重新检查'} onPress={check} disabled={status.kind === 'loading'} />
      <Caption>当前目标和日历仍是演示数据。</Caption>
    </Card>
  </>;
}
