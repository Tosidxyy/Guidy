import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import Head from 'expo-router/head';
import { StatusBar } from 'expo-status-bar';
import { GuidyThemeProvider, useTheme } from '../src/theme/ThemeProvider';

export { ErrorBoundary } from 'expo-router';
export default function RootLayout() {
  return <GuidyThemeProvider><Navigation /></GuidyThemeProvider>;
}
function Navigation() {
  const { colors, scheme } = useTheme();
  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Head><title>Guidy — Chat &amp; Do It.</title></Head>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ title: 'Guidy — Chat & Do It.', headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
        <Stack.Screen name="(tabs)" />
      </Stack>
    </ThemeProvider>
  );
}
