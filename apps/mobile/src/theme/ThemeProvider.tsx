import { createContext, useContext, useState, type PropsWithChildren } from 'react';
import { useColorScheme } from 'react-native';

const light = {
  background: '#F6F6F4', surface: '#FFFFFF', subtle: '#F2F2EF',
  text: '#141414', secondary: '#686868', divider: '#E7E7E4',
  action: '#141414', onAction: '#FFFFFF',
};
const dark: typeof light = {
  background: '#0D0D0D', surface: '#1B1B1B', subtle: '#252525',
  text: '#F5F5F3', secondary: '#ADADAD', divider: '#323232',
  action: '#F3F3F1', onAction: '#111111',
};
export const spacing = { xs: 8, sm: 12, md: 16, lg: 24, xl: 32 } as const;
export const typography = { hero: 30, title: 24, heading: 18, body: 15, caption: 12 } as const;
export type ThemePreference = 'system' | 'light' | 'dark';
type ThemeValue = {
  colors: typeof light;
  scheme: 'light' | 'dark';
  preference: ThemePreference;
  setPreference: (value: ThemePreference) => void;
};
const ThemeContext = createContext<ThemeValue | null>(null);

export function GuidyThemeProvider({ children }: PropsWithChildren) {
  const systemScheme = useColorScheme();
  const [preference, setPreference] = useState<ThemePreference>('system');
  const scheme = preference === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : preference;
  return (
    <ThemeContext.Provider value={{ colors: scheme === 'dark' ? dark : light, scheme, preference, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}
export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('GuidyThemeProvider is required');
  return value;
}
