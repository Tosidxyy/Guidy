import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkHealth, HealthCheckError } from '../src/api/health.ts';

const requestId = 'f3d9f28d-3d5f-47e9-9ad6-24601aa54930';
const body = { data: { status: 'ok', service: 'guidy-api', version: '0.1.0' }, error: null, request_id: requestId };
const baseUrl = 'http://127.0.0.1:8000';
function mockFetch(t, implementation) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => { globalThis.fetch = original; });
}
function response(payload = body, headers = { 'X-Request-ID': requestId }) {
  return new Response(JSON.stringify(payload), { headers });
}
function error(code) {
  return (value) => value instanceof HealthCheckError && value.code === code;
}

test('validates live contract and makes a credential-free health GET', async (t) => {
  mockFetch(t, async (url, options) => {
    assert.equal(url, baseUrl + '/health');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return response();
  });
  assert.deepEqual(await checkHealth({ baseUrl: baseUrl + '/' }), { version: '0.1.0', requestId });
});

test('missing and unsafe origins are rejected before networking', async (t) => {
  mockFetch(t, () => { assert.fail('must not send a request'); });
  await assert.rejects(checkHealth({ baseUrl: '' }), error('not_configured'));
  for (const value of ['not-a-url', 'ftp://example.com', 'http://user:secret@example.com', baseUrl + '/api/v1', baseUrl + '?token=secret', baseUrl + '#secret', 'http://YOUR_WINDOWS_LAN_IP:8000']) {
    await assert.rejects(checkHealth({ baseUrl: value }), error('invalid_url'));
  }
});

test('network errors never echo the raw error or credentials', async (t) => {
  mockFetch(t, async () => { throw new Error('private-token-secret'); });
  await assert.rejects(checkHealth({ baseUrl }), (value) => error('unavailable')(value) && !value.message.includes('secret'));
});

test('HTTP failures are not mistaken for healthy service', async (t) => {
  mockFetch(t, async () => new Response('private-server-secret', { status: 503 }));
  await assert.rejects(checkHealth({ baseUrl }), error('unavailable'));
});

test('invalid JSON and HTML pages are rejected', async (t) => {
  mockFetch(t, async () => new Response('<html>wrong server</html>'));
  await assert.rejects(checkHealth({ baseUrl }), error('invalid_response'));
});

test('wrong service, bad schema and missing/mismatched tracking headers are rejected', async (t) => {
  const fixtures = [
    [null, {}],
    [{ ...body, error: {} }, { 'X-Request-ID': requestId }],
    [{ ...body, data: { ...body.data, service: 'another-api' } }, { 'X-Request-ID': requestId }],
    [{ ...body, data: { ...body.data, status: 'down' } }, { 'X-Request-ID': requestId }],
    [{ ...body, data: { ...body.data, version: 'private-secret' } }, { 'X-Request-ID': requestId }],
    [{ ...body, request_id: 'private-secret' }, { 'X-Request-ID': 'private-secret' }],
    [body, {}],
    [body, { 'X-Request-ID': '00000000-0000-0000-0000-000000000000' }],
  ];
  let index = 0;
  mockFetch(t, async () => {
    const [payload, headers] = fixtures[index++];
    return response(payload, headers);
  });
  for (let attempt = 0; attempt < fixtures.length; attempt++) {
    await assert.rejects(checkHealth({ baseUrl }), error('invalid_response'));
  }
});

test('timeout aborts an outstanding fetch', async (t) => {
  let aborted = false;
  mockFetch(t, (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); }, { once: true });
  }));
  await assert.rejects(checkHealth({ baseUrl, timeoutMs: 10 }), error('timeout'));
  assert.equal(aborted, true);
});

test('caller cancellation aborts fetch and remains distinct from timeout', async (t) => {
  mockFetch(t, (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }));
  const controller = new AbortController();
  const pending = checkHealth({ baseUrl, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error('cancelled'));
});

test('already-cancelled requests do not fetch', async (t) => {
  mockFetch(t, () => { assert.fail('cancelled request must not fetch'); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(checkHealth({ baseUrl, signal: controller.signal }), error('cancelled'));
});
