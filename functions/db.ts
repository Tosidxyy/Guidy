import { fail } from './errors.ts';
export interface DbQuery extends PromiseLike<{ data: any[] | null; error: { code: string; status: number } | null }> {
  select(cols?: string): DbQuery;
  eq(col: string, val: unknown): DbQuery;
  is(col: string, val: unknown): DbQuery;
  order(col: string, opts?: { ascending?: boolean }): DbQuery;
  limit(n: number): DbQuery;
  insert(values: Record<string, unknown> | Record<string, unknown>[]): DbQuery;
  insertIfAbsent(values: Record<string, unknown>, opts: { onConflict: string }): DbQuery;
  update(values: Record<string, unknown>): DbQuery;
  delete(): DbQuery;
}
export interface Db { from(table: string): DbQuery }
export function rows<T = any>(result: { data: T[] | null; error: { code: string; status: number } | null }): T[] {
  if (result.error) fail(result.error.code === 'database_not_configured' ? 'service_unavailable' : 'upstream_error',
    result.error.status >= 400 && result.error.status < 500 ? result.error.status : 503);
  return result.data ?? [];
}