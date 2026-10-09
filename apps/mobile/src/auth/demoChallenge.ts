// Preview-only timings. These are not authentication rules and never contact a service.
export const DEMO_TTL_MS = 60_000;
export const DEMO_COOLDOWN_MS = 5_000;
export const DEMO_WINDOW_MS = 30_000;
export const DEMO_MAX_ISSUES = 3;
export type DemoChallenge = { expiresAt: number };

export function issueDemoChallenge(now: number): DemoChallenge {
  return { expiresAt: now + DEMO_TTL_MS };
}
export function demoExpired(challenge: DemoChallenge | null, now: number): boolean {
  return challenge === null || now >= challenge.expiresAt;
}
export function demoSendGate(history: readonly number[], now: number): { reason: 'cooldown' | 'limited' | null; waitSeconds: number } {
  const recent = history.filter((time) => time > now - DEMO_WINDOW_MS).sort((a, b) => a - b);
  if (recent.length >= DEMO_MAX_ISSUES) {
    return { reason: 'limited', waitSeconds: Math.max(0, Math.ceil((recent[recent.length - DEMO_MAX_ISSUES] + DEMO_WINDOW_MS - now) / 1000)) };
  }
  const last = history.length ? Math.max(...history) : -Infinity;
  const waitSeconds = Math.max(0, Math.ceil((last + DEMO_COOLDOWN_MS - now) / 1000));
  return { reason: waitSeconds ? 'cooldown' : null, waitSeconds };
}
