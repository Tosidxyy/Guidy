import assert from 'node:assert/strict';
import test from 'node:test';
import { createDraft, parseDraft } from '../src/goals/draft.ts';

test('draft survives serialization, keeps optional time and trims input', () => {
  const draft = createDraft('  学英语  ', '');
  assert.deepEqual(parseDraft(JSON.stringify(draft)), draft);
  assert.equal(draft.description, '学英语');
  assert.equal(parseDraft(null), null);
});
test('blank or excessive inputs cannot create a draft', () => {
  for (const value of ['', '  ', '字'.repeat(301)]) assert.throws(() => createDraft(value, ''));
  assert.throws(() => createDraft('学习', '字'.repeat(81)));
});
test('corrupted or unsupported storage must not silently become empty', () => {
  for (const raw of ['bad', '{}', 'null', JSON.stringify({ ...createDraft('学习', ''), version: 2 }), JSON.stringify({ ...createDraft('学习', ''), updatedAt: 'bad' })]) assert.throws(() => parseDraft(raw));
});

test('a persisted submission key survives reload but malformed keys fail closed', () => {
  const draft = { ...createDraft('学习', ''), submissionKey: 'goal_retry_key_001' };
  assert.equal(parseDraft(JSON.stringify(draft)).submissionKey, draft.submissionKey);
  assert.throws(() => parseDraft(JSON.stringify({ ...draft, submissionKey: 'invalid key' })));
});
