import { View } from 'react-native';
import { Action, AppText, Badge, Caption, Card, Screen, SectionTitle, styles } from '../../src/components/ui';
import { useTheme } from '../../src/theme/ThemeProvider';

export default function GoalsScreen() {
  const { colors } = useTheme();
  return (
    <Screen title="Guidy">
      <View><AppText accessibilityRole="header" style={styles.hero}>今天，向前一点。</AppText><Caption>有想法，就让它发生。Chat &amp; Do It.</Caption></View>
      <Action label="＋ 创建新目标 · M1 开放" disabled />
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
