import { ConstraintSetArtifactSchema, PatchArtifactSchema, QuestionCardArtifactSchema } from './shared/schemas.ts';
import type { ConstraintSetArtifact, PatchArtifact, QuestionCardArtifact } from './shared/schemas.ts';
import { splitArtifactText } from './shared/artifactText.ts';
export type ParsedArtifact =
  | { kind: 'constraint_set'; value: ConstraintSetArtifact }
  | { kind: 'patch'; value: PatchArtifact }
  | { kind: 'question_card'; value: QuestionCardArtifact };

const DAY_MS = 86400000;

/** 截止日硬护栏：跨度取 ≥「开始日→截止日」自然天数的最小档位，模型输出再大也拉回。 */
function clampHorizonToDeadline(value: ConstraintSetArtifact, today: string): ConstraintSetArtifact {
  const deadline = value.constraints.find((c) => c.type === 'deadline');
  if (!deadline) return value;
  const start = value.horizon_start ?? today;
  const span = Math.round((Date.parse(`${deadline.date}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
  if (span <= 0) return value;
  const fit = Math.min(365, Math.max(1, span));
  return fit === value.horizon_days ? value : { ...value, horizon_days: fit };
}

function coerce(obj: unknown, today: string): ParsedArtifact | null {
  if (!obj || typeof obj !== 'object') return null;
  const type = (obj as { type?: string }).type;
  if (type === 'constraint_set') {
    const r = ConstraintSetArtifactSchema.safeParse(obj);
    return r.success ? { kind: 'constraint_set', value: clampHorizonToDeadline(r.data, today) } : null;
  }
  if (type === 'question_card') {
    const r = QuestionCardArtifactSchema.safeParse(obj);
    return r.success ? { kind: 'question_card', value: r.data } : null;
  }
  if (type === 'patch') {
    const ops = Array.isArray((obj as { ops?: unknown }).ops)
      ? ((obj as { ops: unknown[] }).ops).map((op) => {
          if (!op || typeof op !== 'object' || 'op' in op) return op;
          const legacy = op as { type?: unknown };
          if (typeof legacy.type !== 'string') return op;
          const { type: opName, ...rest } = legacy;
          return { ...rest, op: opName };
        })
      : (obj as { ops?: unknown }).ops;
    const r = PatchArtifactSchema.safeParse({ ...(obj as object), ops });
    return r.success ? { kind: 'patch', value: r.data } : null;
  }
  return null;
}

/** 按结构边界补齐未闭合的 JSON：从截断处回退，丢掉半截元素，闭合剩余层级。 */
function closeJson(prefix: string): string | null {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') { if (stack.pop() !== ch) return null; }
  }
  let out = prefix.trimEnd();
  if (inStr) out += '"';
  out = out.replace(/[,:\s]+$/, '');
  if (!out || !stack.length) return null;
  return out + stack.reverse().join('');
}

const SALVAGE_TYPE_RE = /"type"\s*:\s*"(constraint_set|patch|question_card)"/;

/**
 * 输出被 max_tokens 截断时的兜底：从最后一个结构分隔符往前找，补括号后尝试 schema 校验。
 * 只救「已经输出产物、只是没写完」的情况；丢弃半截的 task/op，避免整轮空手而归。
 */
function salvageArtifacts(raw: string, today: string): ParsedArtifact | null {
  if (!SALVAGE_TYPE_RE.test(raw)) return null;
  const cuts: number[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === ',' || ch === '{' || ch === '[') cuts.push(i);
  }
  const budget = Math.min(cuts.length, 120);
  for (let k = cuts.length - 1; k >= cuts.length - budget; k--) {
    const closed = closeJson(raw.slice(0, cuts[k]));
    if (closed === null) continue;
    let obj: unknown;
    try { obj = JSON.parse(closed); } catch { continue; }
    // 截断发生在靠前的字段时，后面必填的空数组还没输出：按空值补齐（不臆造任务/约束内容）。
    if (obj && typeof obj === 'object' && (obj as { type?: string }).type === 'constraint_set') {
      const o = obj as Record<string, unknown>;
      obj = { constraints: [], clarifications_needed: [], ...o };
    }
    const parsed = coerce(obj, today);
    if (parsed) return parsed;
  }
  return null;
}

export function parseModelText(text: string, today?: string): ParsedArtifact | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  // 无闭合围栏/裸行内 JSON 也需可解析（与气泡剥离共用同一识别逻辑）。
  const raw = (fenced ? fenced[1] : (splitArtifactText(text).artifactJson ?? text)).trim();
  let obj: unknown;
  let complete = true;
  try { obj = JSON.parse(raw); } catch { obj = undefined; complete = false; }
  const day = today ?? new Date().toISOString().slice(0, 10);
  const direct = coerce(obj, day);
  if (direct) return direct;
  // 语法完整但 schema 不合法（模型写错字段/枚举）→ 明确失败，交给修复重试，不猜。
  if (complete) return null;
  return salvageArtifacts(raw, day);
}