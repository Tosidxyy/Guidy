import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';

// UI preview only. This value is never an authentication session or an API credential.
export const DEMO_EMAIL = 'demo@example.invalid';
export const DEMO_CODE = '123456';
type DemoAccount = { demoSignedIn: boolean; enterDemo: () => void; leaveDemo: () => void };
const DemoAccountContext = createContext<DemoAccount | null>(null);

export function DemoAccountProvider({ children }: PropsWithChildren) {
  const [demoSignedIn, setDemoSignedIn] = useState(false);
  const value = useMemo(() => ({
    demoSignedIn,
    enterDemo: () => setDemoSignedIn(true),
    leaveDemo: () => setDemoSignedIn(false),
  }), [demoSignedIn]);
  return <DemoAccountContext.Provider value={value}>{children}</DemoAccountContext.Provider>;
}

export function useDemoAccount() {
  const value = useContext(DemoAccountContext);
  if (!value) throw new Error('DemoAccountProvider is required');
  return value;
}
