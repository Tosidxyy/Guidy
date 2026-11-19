-- 幂等认领表：idempotency_key 主键由数据库保证唯一，避免两个并发请求同时执行提交。
-- plan_id 可空（认领时尚未创建/确认），state: pending | done | failed。
CREATE TABLE app.commit_claims (
  idempotency_key text PRIMARY KEY,
  visitor_id text NOT NULL,
  plan_id uuid,
  state text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commit_claims_visitor_idx ON app.commit_claims (visitor_id, created_at);