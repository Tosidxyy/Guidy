import type { Db } from './db.ts';
export interface RouteCtx { request: Request; user?: { id: string } | null; requestId?: string }
export interface QcaBinding { agent: { type: 'agent'; id: string; version: number }; environment_id: string }
export interface QcaAdapter {
  ensureBinding(scope: string): Promise<QcaBinding>;
  createSession(binding: QcaBinding, title: string, metadata: Record<string, string>): Promise<{ id: string }>;
  sendEvents(sessionId: string, text: string, idempotencyKey: string): Promise<{ eventIds: string[] }>;
  openStream(sessionId: string, opts: { lastEventId?: string; signal?: AbortSignal }): Promise<{ body: ReadableStream<Uint8Array>; close(): void }>;
  listEvents(sessionId: string, opts: { order?: 'asc' | 'desc'; limit?: number }): Promise<{ data: any[]; has_more: boolean; next_page?: string }>;
}
export interface Deps {
  db: Db;
  requireUser: (ctx: RouteCtx) => { id: string };
  qca: QcaAdapter;
  config: { cloudApiOrigin: string; appScope: string; modelId: string };
  now?: () => Date;
}
export type AppEvent =
  | { event: 'accepted'; data: { request_id: string; conversation_id: string; seq: number } }
  | { event: 'delta'; data: { seq: number; text: string } }
  | { event: 'artifact'; data: { seq: number; kind: 'constraint_set' | 'patch'; payload: unknown } }
  | { event: 'status'; data: { seq: number; state: 'running' | 'waiting_confirm' | 'completed' | 'interrupted' | 'failed' } }
  | { event: 'error'; data: { seq: number; code: string; message: string; diagnostic_id: string } }
  | { event: 'done'; data: { seq: number } };