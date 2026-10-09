import type { PropsWithChildren } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View, type TextProps, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { spacing, typography, useTheme } from '../theme/ThemeProvider';

export function AppText({ style, ...props }: TextProps) {
  const { colors } = useTheme();
  return <Text {...props} style={[{ color: colors.text, fontSize: typography.body, lineHeight: 23 }, style]} />;
}
export function Screen({ title, children, bottomInset = false }: PropsWithChildren<{ title: string; bottomInset?: boolean }>) {
  const { colors } = useTheme();
  return (
    <SafeAreaView edges={bottomInset ? ['top', 'left', 'right', 'bottom'] : ['top', 'left', 'right']} style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <View style={styles.brand}>
          <Image source={require('../../assets/images/icon.png')} style={styles.logo} accessibilityLabel="Guidy 标识" />
          <AppText accessibilityRole="header" style={styles.title}>{title}</AppText>
        </View>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}
export function Card({ children, style }: PropsWithChildren<{ style?: ViewStyle }>) {
  const { colors } = useTheme();
  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.divider }, style]}>{children}</View>;
}
export function Badge({ children }: PropsWithChildren) {
  const { colors } = useTheme();
  return <View style={[styles.badge, { backgroundColor: colors.subtle }]}><AppText style={styles.caption}>{children}</AppText></View>;
}
export function Caption({ children }: PropsWithChildren) {
  const { colors } = useTheme();
  return <AppText style={{ color: colors.secondary, fontSize: typography.caption, lineHeight: 19 }}>{children}</AppText>;
}
export function SectionTitle({ children }: PropsWithChildren) {
  return <AppText accessibilityRole="header" style={styles.heading}>{children}</AppText>;
}
export function Action({ label, onPress, disabled = false, secondary = false }: { label: string; onPress?: () => void; disabled?: boolean; secondary?: boolean }) {
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.action, { backgroundColor: secondary ? colors.subtle : colors.action, opacity: disabled ? 0.55 : pressed ? 0.8 : 1 }]}>
      <AppText style={{ color: secondary ? colors.text : colors.onAction, fontWeight: '600', textAlign: 'center' }}>{label}</AppText>
    </Pressable>
  );
}
export const styles = StyleSheet.create({
  screen: { padding: spacing.lg, gap: spacing.md, width: '100%', maxWidth: 600, alignSelf: 'center', paddingBottom: spacing.xl },
  brand: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  logo: { width: 34, height: 34 },
  title: { fontSize: typography.title, fontWeight: '700', lineHeight: 32 },
  hero: { fontSize: typography.hero, fontWeight: '700', lineHeight: 40 },
  heading: { fontSize: typography.heading, fontWeight: '600', lineHeight: 27, marginTop: spacing.sm },
  card: { borderWidth: 1, borderRadius: 18, padding: spacing.md, gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  badge: { paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: 20, alignSelf: 'flex-start' },
  caption: { fontSize: typography.caption, lineHeight: 19, fontWeight: '500' },
  action: { minHeight: 52, padding: spacing.md, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
});
