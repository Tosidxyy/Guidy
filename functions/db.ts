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

function assertNoError(result: { error: { code: string; status: number } | null }): void {
  if (result?.error) rows(result as { data: null; error: typeof result.error });
}

/**
 * 严格包装：任何一次查询失败（含写操作）都会抛出，避免 insert/update/delete 的
 * 错误被静默丢弃、接口仍返回 200。application() 用它包住依赖注入的 db。
 * 不用 Proxy：平台 SDK 的查询方法是非可配置只读属性，代理包装会触发 TypeError。
 */
export function strictDb(db: Db): Db {
  const METHODS = ['select', 'eq', 'is', 'order', 'limit', 'insert', 'insertIfAbsent', 'update', 'delete'] as const;
  return {
    from(table: string): DbQuery {
      let q: any = db.from(table);
      const wrapper: any = {
        then(onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
          return Promise.resolve(q).then((r: any) => { assertNoError(r); return r; }).then(onFulfilled, onRejected);
        },
      };
      for (const m of METHODS) {
        wrapper[m] = (...args: unknown[]) => { q = q[m](...args); return wrapper; };
      }
      return wrapper as DbQuery;
    },
  };
}