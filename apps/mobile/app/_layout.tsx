import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import Head from 'expo-router/head';
import { StatusBar } from 'expo-status-bar';
import { GuidyThemeProvider, useTheme } from '../src/theme/ThemeProvider';
import { DemoAccountProvider } from '../src/auth/DemoAccountProvider';

export { ErrorBoundary } from 'expo-router';
export default function RootLayout() {
  return <GuidyThemeProvider><DemoAccountProvider><Navigation /></DemoAccountProvider></GuidyThemeProvider>;
}
function Navigation() {
  const { colors, scheme } = useTheme();
  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Head><title>Guidy — Chat &amp; Do It.</title></Head>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ title: 'Guidy — Chat & Do It.', headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="(auth)/sign-in" />
      </Stack>
    </ThemeProvider>
  );
}
