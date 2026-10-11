CREATE TABLE plan_draft_attempts (
 id TEXT PRIMARY KEY NOT NULL,
 goal_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 goal_revision INTEGER NOT NULL CHECK(goal_revision>=0),
 request_key TEXT NOT NULL,
 request_payload TEXT NOT NULL CHECK(json_valid(request_payload)),
 context_json TEXT NOT NULL CHECK(json_valid(context_json)),
 status TEXT NOT NULL CHECK(status IN ('submitted','succeeded','failed','unknown')),
 draft_json TEXT CHECK(draft_json IS NULL OR json_valid(draft_json)),
 error_code TEXT,
 input_tokens INTEGER,
 output_tokens INTEGER,
 created_at INTEGER NOT NULL,
 lease_until INTEGER NOT NULL,
 CHECK((status='succeeded' AND draft_json IS NOT NULL AND error_code IS NULL) OR (status!='succeeded' AND draft_json IS NULL)),
 UNIQUE(owner_id,request_key),
 FOREIGN KEY(goal_id,owner_id) REFERENCES goals(id,owner_id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX idx_plan_draft_active ON plan_draft_attempts(goal_id) WHERE status='submitted';
CREATE TABLE plan_draft_usage (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_plan_usage_day ON plan_draft_usage(created_at);
CREATE INDEX idx_plan_usage_owner_day ON plan_draft_usage(owner_id,created_at);
