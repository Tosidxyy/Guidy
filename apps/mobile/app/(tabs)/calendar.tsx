import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { AppText, Badge, Caption, Card, Screen, SectionTitle, styles } from '../../src/components/ui';
import { useTheme } from '../../src/theme/ThemeProvider';

const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
export default function CalendarScreen() {
  const { colors } = useTheme();
  const [selectedDay, setSelectedDay] = useState(9);
  return (
    <Screen title="日历">
      <Caption>M0 界面预览 · 2026 年 10 月示例周；尚未接入排程或提醒。</Caption>
      <AppText accessibilityRole="header" style={styles.title}>2026 年 10 月</AppText>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="radiogroup" accessibilityLabel="选择演示日期" contentContainerStyle={{ flexGrow: 1 }}>
        {weekdays.map((day, index) => {
          const date = index + 5;
          const active = date === selectedDay;
          return (
            <View key={day} style={{ flex: 1, minWidth: 44, alignItems: 'center', gap: 8 }}>
              <Caption>{day}</Caption>
              <Pressable onPress={() => setSelectedDay(date)} accessibilityRole="radio" accessibilityLabel={`10月${date}日`} accessibilityState={{ checked: active }} aria-checked={active}
                style={{ minWidth: 44, minHeight: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? colors.action : 'transparent' }}>
                <AppText style={{ color: active ? colors.onAction : colors.text, fontWeight: active ? '700' : '400' }}>{date}</AppText>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
      <SectionTitle>10 月 {selectedDay} 日</SectionTitle>
      {selectedDay === 9 ? <>
        <Card><Caption>18:30 · 演示任务</Caption><AppText style={styles.heading}>全身训练</AppText><Caption>45 分钟 · 健身计划</Caption><View style={styles.row}><Badge>已确认 · 演示</Badge><Badge>提醒状态未接入</Badge></View></Card>
        <Card><Caption>19:30 · 演示固定事件</Caption><AppText style={styles.heading}>晚餐</AppText><Caption>固定事件 · 不参与自动移动</Caption></Card>
      </> : <Card><AppText>这一天没有演示安排</AppText><Caption>真实日程将在 M2 排程确认后显示。</Caption></Card>}
      <Caption>执行反馈与本地通知在 M2 实现；当前不会写入日历或注册系统提醒。</Caption>
    </Screen>
  );
}
