import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boot = vi.hoisted(() => ({
  cloud: vi.fn(), legacy: vi.fn(), plan: vi.fn(), history: vi.fn(),
  render: vi.fn(), root: vi.fn(),
}));
vi.mock('react-dom/client', () => ({ createRoot: boot.root }));
vi.mock('@/src/App', () => ({ default: () => null }));
vi.mock('@/lib/api', () => ({ LEGACY_BASE: '/legacy' }));
vi.mock('@/lib/local/domain', () => ({ migrateFromCloudOnce: boot.cloud }));
vi.mock('@/lib/storage', () => ({ migrateLegacyPlanOnce: boot.legacy }));
vi.mock('@/store/usePlanStore', () => ({ usePlanStore: { getState: () => ({ hydrate: boot.plan }) } }));
vi.mock('@/store/useBlockHistory', () => ({ useBlockHistory: { getState: () => ({ hydrate: boot.history }) } }));

let replaceChildren: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  boot.root.mockReturnValue({ render: boot.render });
  replaceChildren = vi.fn();
  vi.stubGlobal('document', {
    getElementById: () => ({ replaceChildren }),
    createElement: () => ({ setAttribute: vi.fn(), textContent: '' }),
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('startup storage barrier', () => {
  it('waits for cloud, legacy migration, plan hydration and undo hydration before rendering', async () => {
    let releaseCloud!: () => void;
    let releasePlan!: () => void;
    let releaseHistory!: () => void;
    boot.cloud.mockImplementation(() => new Promise<void>((resolve) => { releaseCloud = resolve; }));
    boot.plan.mockImplementation(() => new Promise<void>((resolve) => { releasePlan = resolve; }));
    boot.history.mockImplementation(() => new Promise<void>((resolve) => { releaseHistory = resolve; }));
    await import('@/src/main');
    expect(boot.cloud).toHaveBeenCalledOnce();
    expect(boot.legacy).not.toHaveBeenCalled();
    expect(boot.root).not.toHaveBeenCalled();
    releaseCloud();
    await vi.waitFor(() => expect(boot.plan).toHaveBeenCalledOnce());
    expect(boot.legacy).toHaveBeenCalledOnce();
    expect(boot.history).not.toHaveBeenCalled();
    releasePlan();
    await vi.waitFor(() => expect(boot.history).toHaveBeenCalledOnce());
    expect(boot.root).not.toHaveBeenCalled();
    releaseHistory();
    await vi.waitFor(() => expect(boot.render).toHaveBeenCalledOnce());
    expect(replaceChildren).not.toHaveBeenCalled();
  });

  it.each(['legacy', 'plan', 'history'] as const)('does not mount editable empty state when %s fails', async (stage) => {
    boot.cloud.mockResolvedValue(undefined);
    boot[stage].mockRejectedValue(new Error('storage unavailable'));
    await import('@/src/main');
    await vi.waitFor(() => expect(replaceChildren).toHaveBeenCalledOnce());
    expect(boot.root).not.toHaveBeenCalled();
    const [message] = replaceChildren.mock.calls[0];
    expect(message.textContent).toContain('storage unavailable');
    expect(message.textContent).toContain('未清除任何数据');
  });
});
