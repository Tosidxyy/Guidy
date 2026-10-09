import { Link, Stack } from 'expo-router';
import { AppText, Screen } from '../src/components/ui';
export default function NotFoundScreen() {
  return <Screen title="Guidy"><Stack.Screen options={{ title: '页面不存在' }} /><AppText>这个页面不存在。</AppText><Link href="/goals" style={{ paddingVertical: 16 }}>返回目标首页</Link></Screen>;
}
