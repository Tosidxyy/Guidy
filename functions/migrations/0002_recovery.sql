CREATE TABLE app.recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id text NOT NULL,
  code_hash text NOT NULL UNIQUE,
  used_at timestamptz,
  claimed_by text,
  overwritten_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recovery_codes_visitor_idx ON app.recovery_codes (visitor_id);
-- 受限 DDL：新增列必须可空且无默认值；历史行 NULL 由 incrementRecoveryAttempt 归一化为 0
ALTER TABLE app.quotas ADD COLUMN recovery_attempts integer;