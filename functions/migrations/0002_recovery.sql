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
ALTER TABLE app.quotas ADD COLUMN recovery_attempts integer NOT NULL DEFAULT 0;