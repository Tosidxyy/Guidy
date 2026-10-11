CREATE TABLE planning_jobs (
 id TEXT PRIMARY KEY NOT NULL,
 source_run_id TEXT NOT NULL UNIQUE,
 goal_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 goal_revision INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','deciding','research_ready','searching','plan_ready','generating','completed','failed','unknown')),
 context_json TEXT NOT NULL CHECK(json_valid(context_json)),
 decision_json TEXT CHECK(decision_json IS NULL OR json_valid(decision_json)),
 sources_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(sources_json)),
 error_code TEXT,
 dispatched INTEGER NOT NULL DEFAULT 0 CHECK(dispatched IN (0,1)),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 lease_until INTEGER NOT NULL,
 FOREIGN KEY(source_run_id,goal_id,owner_id) REFERENCES agent_runs(id,goal_id,owner_id) ON DELETE CASCADE,
 FOREIGN KEY(goal_id,owner_id) REFERENCES goals(id,owner_id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX idx_planning_active_goal ON planning_jobs(goal_id)
 WHERE status IN ('queued','deciding','research_ready','searching','plan_ready','generating');
