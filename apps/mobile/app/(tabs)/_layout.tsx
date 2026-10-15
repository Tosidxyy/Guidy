import { Tabs } from 'expo-router';
import {TabIcon} from '../../src/components/TabIcon';
import { useTheme } from '../../src/theme/ThemeProvider';

export default function TabLayout() {
  const { colors } = useTheme();
  return (
    <Tabs initialRouteName="goals" screenOptions={{ headerShown: false,
      tabBarActiveTintColor: colors.text, tabBarInactiveTintColor: colors.secondary,
      tabBarStyle: { minHeight: 64, backgroundColor: colors.surface, borderTopColor: colors.divider },
      tabBarItemStyle: { minHeight: 48 }, tabBarLabelStyle: { fontSize: 12 } }}>
      <Tabs.Screen name="goals" options={{ title: '目标', tabBarIcon: ({ color }) => <TabIcon name="goals" color={color}/> }} />
      <Tabs.Screen name="calendar" options={{ title: '日历', tabBarIcon: ({ color }) => <TabIcon name="calendar" color={color}/> }} />
      <Tabs.Screen name="me" options={{ title: '我的', tabBarIcon: ({ color }) => <TabIcon name="me" color={color}/> }} />
    </Tabs>
  );
}
