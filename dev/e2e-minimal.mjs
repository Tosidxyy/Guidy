// 最小闭环 E2E：真实模型 → constraint_set → commit 落库 → 读回验证。
// 用法：node dev/e2e-minimal.mjs ["明天下午2点学习两小时。"]
// 环境：先启动 npm run dev:function:live（默认 http://127.0.0.1:8000）。
const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:8000/functions/v1/app/api';
const TEXT = process.argv[2] ?? '明天下午2点学习两小时。';
const visitor = process.env.E2E_VISITOR ?? `e2e-${Date.now()}`;
const cookie = `dev_visitor=${encodeURIComponent(visitor)}`;
const TZ = 'Asia/Shanghai';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function todayStr() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

async function post(path, body, timeoutMs = 60000) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, signal: AbortSignal.timeout(30000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function sendChat(text) {
  const started = Date.now();
  const res = await fetch(`${BASE}/chat/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text, timezone: TZ, today: todayStr() }),
    signal: AbortSignal.timeout(600000),
  });
  if (!res.ok) throw new Error(`chat/send ${res.status}: ${await res.text()}`);
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = chunk.split('\n');
      const evLine = lines.find((l) => l.startsWith('event:'));
      const dataLine = lines.find((l) => l.startsWith('data:'));
      if (!evLine || !dataLine) continue;
      try { events.push({ event: evLine.slice(6).trim(), data: JSON.parse(dataLine.slice(5).trim()) }); } catch { /* 非 JSON 帧 */ }
    }
  }
  return { events, elapsedMs: Date.now() - started };
}

function summarize(events) {
  const counts = {};
  for (const e of events) counts[e.event] = (counts[e.event] ?? 0) + 1;
  const artifact = events.find((e) => e.event === 'artifact');
  const status = [...events].reverse().find((e) => e.event === 'status');
  const error = events.find((e) => e.event === 'error');
  const text = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
  return { counts, artifact, status, error, text };
}

function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

async function main() {
  const report = { visitor, text: TEXT, today: todayStr() };
  console.log(`[e2e] visitor=${visitor} text="${TEXT}"`);

  const chat = await sendChat(TEXT);
  const s = summarize(chat.events);
  report.chat = {
    elapsed_ms: chat.elapsedMs,
    events: s.counts,
    status: s.status?.data?.state ?? null,
    error: s.error?.data ?? null,
    artifact_kind: s.artifact?.data?.kind ?? null,
    assistant_chars: s.text.length,
  };
  console.log('[e2e] chat:', JSON.stringify(report.chat));
  if (!s.artifact || s.artifact.data.kind !== 'constraint_set') {
    report.result = 'FAIL_NO_ARTIFACT';
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  const draft = s.artifact.data.payload;
  const horizon_start = draft.horizon_start ?? todayStr();
  const constraints = draft.constraints.map((payload, i) => ({ id: `e2e-${i}`, payload, source: 'ai', enabled: true }));
  const preview_id = crypto.randomUUID();
  const commit = await post('/plans/commit', {
    preview_id,
    plan_id: null,
    result_hash: 'e2e-harness',
    engine_version: 1,
    conversation_id: null,
    input: { title: draft.plan_title, horizon_start, horizon_days: draft.horizon_days, timezone: TZ, task_defs: draft.task_defs, constraints },
  }, 120000);
  report.commit = { status: commit.status, code: commit.body?.error?.code ?? null, error: commit.body?.error ?? null };
  console.log('[e2e] commit:', JSON.stringify(report.commit));
  if (commit.status !== 200) {
    report.result = 'FAIL_COMMIT';
    console.log(JSON.stringify(report, null, 2));
    process.exit(3);
  }

  const planId = commit.body.plan.id;
  const readBack = await get(`/plans/${planId}`);
  const blocks = readBack.body?.blocks ?? [];
  const taskMinutes = {};
  let allUuid = true;
  for (const b of blocks) {
    if (!UUID_RE.test(b.id)) allUuid = false;
    const key = b.task_key ?? `(fixed:${b.title})`;
    taskMinutes[key] = (taskMinutes[key] ?? 0) + Math.round((Date.parse(b.end_utc) - Date.parse(b.start_utc)) / 60000);
  }
  const expected = draft.task_defs.reduce((m, t) => {
    const times = t.frequency.type === 'daily' ? draft.horizon_days : t.frequency.type === 'per_week' ? t.frequency.count * Math.ceil(draft.horizon_days / 7) : 1;
    return m + t.duration_min * times;
  }, 0);
  report.readback = {
    status: readBack.status,
    plan_id: planId,
    version: readBack.body?.plan?.version ?? null,
    blocks: blocks.length,
    all_ids_uuid: allUuid,
    task_minutes: taskMinutes,
    expected_minutes: expected,
    calendar_ok: (await get('/calendar')).status === 200,
    sample_blocks: blocks.slice(0, 4).map((b) => ({ id: b.id, title: b.title, start: b.start_utc, end: b.end_utc, task_key: b.task_key ?? null })),
  };
  report.result = blocks.length > 0 && allUuid ? 'PASS' : 'FAIL_READBACK';
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.result === 'PASS' ? 0 : 4);
}

void addDays;
main().catch((e) => { console.error('[e2e] fatal:', e); process.exit(1); });