CREATE TABLE search_attempts (
 id TEXT PRIMARY KEY NOT NULL,
 goal_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 goal_revision INTEGER NOT NULL CHECK(goal_revision>=0),
 request_key TEXT NOT NULL,
 query TEXT NOT NULL CHECK(length(query) BETWEEN 1 AND 200),
 provider TEXT NOT NULL CHECK(provider='doubao-custom'),
 status TEXT NOT NULL CHECK(status IN ('submitted','succeeded','failed','unknown')),
 billing_status TEXT NOT NULL DEFAULT 'reserved_unknown' CHECK(billing_status='reserved_unknown'),
 result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
 error_code TEXT,
 created_at INTEGER NOT NULL,
 lease_until INTEGER NOT NULL,
 CHECK((status='succeeded' AND result_json IS NOT NULL AND error_code IS NULL) OR (status!='succeeded' AND result_json IS NULL)),
 UNIQUE(owner_id,request_key),
 FOREIGN KEY(goal_id,owner_id) REFERENCES goals(id,owner_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX idx_search_owner_day ON search_attempts(owner_id,created_at);
CREATE INDEX idx_search_day ON search_attempts(created_at);
CREATE UNIQUE INDEX idx_search_active ON search_attempts(goal_id) WHERE status='submitted';
-- Minimal daily reservation survives goal deletion; no query or source text.
CREATE TABLE search_usage (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_search_usage_day ON search_usage(created_at);
CREATE INDEX idx_search_usage_owner_day ON search_usage(owner_id,created_at);
