import assert from 'node:assert/strict';
import test from 'node:test';
import { checkedSlots, emptySlots } from '../src/goals/clarification.ts';

test('unknown conditions remain unknown and cannot masquerade as confirmed input', () => {
  assert.ok(emptySlots().every(s => s.state === 'unknown' && s.text === ''));
  const value = { key: 'available_time', value: { schema_version: 1, state: 'unknown', text: '' }, source: 'user', confirmed_at: null };
  assert.equal(checkedSlots([value])[0].confirmed_at, null);
  assert.throws(() => checkedSlots([{ ...value, value: { ...value.value, text: 'guess' } }]));
  assert.throws(() => checkedSlots([{ ...value, confirmed_at: 123 }]));
});
test('confirmed data requires user provenance, supported schema and a valid timestamp', () => {
  const value = { key: 'outcome', value: { schema_version: 1, state: 'confirmed', text: '能简单交流' }, source: 'user', confirmed_at: 123 };
  assert.equal(checkedSlots([value])[0].value.text, value.value.text);
  for (const invalid of [{ ...value, source: 'agent' }, { ...value, confirmed_at: null }, { ...value, value: { ...value.value, schema_version: 2 } }, { ...value, value: { ...value.value, text: '' } }]) assert.throws(() => checkedSlots([invalid]));
  assert.throws(() => checkedSlots([value, value]));
});
