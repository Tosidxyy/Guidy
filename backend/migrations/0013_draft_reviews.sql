CREATE UNIQUE INDEX idx_plan_attempt_scope ON plan_draft_attempts(id,goal_id,owner_id);
CREATE TABLE plan_draft_reviews (
 id TEXT PRIMARY KEY NOT NULL,
 attempt_id TEXT NOT NULL,
 goal_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 20),
 goal_revision INTEGER NOT NULL CHECK(goal_revision>=0),
 request_key TEXT NOT NULL,
 request_payload TEXT NOT NULL CHECK(json_valid(request_payload)),
 draft_json TEXT NOT NULL CHECK(json_valid(draft_json)),
 created_at INTEGER NOT NULL,
 UNIQUE(attempt_id,revision),
 UNIQUE(owner_id,request_key),
 FOREIGN KEY(attempt_id,goal_id,owner_id) REFERENCES plan_draft_attempts(id,goal_id,owner_id) ON DELETE CASCADE
) STRICT;
