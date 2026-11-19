-- 发布竞态防护：版本认领时写入当前执行者 fence，发布 CAS 同时校验，
-- 使“fence 检查之后、发布之前被接管”的执行者无法发布（单行条件更新即原子保护）。
ALTER TABLE app.plans ADD COLUMN pending_fence integer;
