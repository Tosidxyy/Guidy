import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoExpired, demoSendGate, issueDemoChallenge } from '../src/auth/demoChallenge.ts';

test('challenge expires at deadline even after a suspended timer', () => {
  const challenge = issueDemoChallenge(1000);
  assert.equal(demoExpired(challenge, 60_999), false);
  assert.equal(demoExpired(challenge, 61_000), true);
  assert.equal(demoExpired(challenge, 120_000), true);
  assert.equal(demoExpired(null, 1000), true);
});
test('cooldown ends exactly on its boundary and older issues do not block', () => {
  assert.deepEqual(demoSendGate([], 0), { reason: null, waitSeconds: 0 });
  assert.deepEqual(demoSendGate([1000], 5999), { reason: 'cooldown', waitSeconds: 1 });
  assert.deepEqual(demoSendGate([1000], 6000), { reason: null, waitSeconds: 0 });
  assert.deepEqual(demoSendGate([1000], 100_000), { reason: null, waitSeconds: 0 });
});
test('rolling rate limit clears when the oldest issue leaves the window', () => {
  const history = [0, 5000, 10000];
  assert.deepEqual(demoSendGate(history, 15000), { reason: 'limited', waitSeconds: 15 });
  assert.deepEqual(demoSendGate(history, 30000), { reason: null, waitSeconds: 0 });
  assert.deepEqual(demoSendGate([1000, 1000, 1000], 2000), { reason: 'limited', waitSeconds: 29 });
});
