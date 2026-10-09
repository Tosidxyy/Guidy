import { Tabs } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useTheme } from '../../src/theme/ThemeProvider';

export default function TabLayout() {
  const { colors } = useTheme();
  return (
    <Tabs initialRouteName="goals" screenOptions={{ headerShown: false,
      tabBarActiveTintColor: colors.text, tabBarInactiveTintColor: colors.secondary,
      tabBarStyle: { minHeight: 64, backgroundColor: colors.surface, borderTopColor: colors.divider },
      tabBarItemStyle: { minHeight: 48 }, tabBarLabelStyle: { fontSize: 12 } }}>
      <Tabs.Screen name="goals" options={{ title: '目标', tabBarIcon: ({ color }) => <SymbolView name={{ ios: 'target', android: 'target', web: 'target' }} tintColor={color} size={24} /> }} />
      <Tabs.Screen name="calendar" options={{ title: '日历', tabBarIcon: ({ color }) => <SymbolView name={{ ios: 'calendar', android: 'calendar_month', web: 'calendar_month' }} tintColor={color} size={24} /> }} />
      <Tabs.Screen name="me" options={{ title: '我的', tabBarIcon: ({ color }) => <SymbolView name={{ ios: 'person', android: 'person', web: 'person' }} tintColor={color} size={24} /> }} />
    </Tabs>
  );
}
