import { createContext, useContext, type PropsWithChildren } from 'react';
import { authClient, signOutConfirmed } from './client';

type Account = { user: { id: string; name: string; email: string } | null; pending: boolean; error: string; refresh: () => Promise<void>; signOut: () => Promise<void> };
const Context = createContext<Account | null>(null);
export function AuthProvider({ children }: PropsWithChildren) {
  if (!authClient) return <Context.Provider value={{ user: null, pending: false, error: '请配置服务地址后重启 App。', refresh: async () => {}, signOut: async () => {} }}>{children}</Context.Provider>;
  return <ConnectedAuthProvider>{children}</ConnectedAuthProvider>;
}
function ConnectedAuthProvider({ children }: PropsWithChildren) {
  const client = authClient!;
  const session = client.useSession();
  return <Context.Provider value={{ user: session.error ? null : session.data?.user ?? null, pending: session.isPending,
    error: session.error ? '无法验证账号状态，请检查连接后重试。' : '',
    refresh: async () => { await session.refetch(); },
    signOut: signOutConfirmed,
  }}>{children}</Context.Provider>;
}
export function useAccount() {
  const value = useContext(Context);
  if (!value) throw new Error('AuthProvider is required');
  return value;
}
