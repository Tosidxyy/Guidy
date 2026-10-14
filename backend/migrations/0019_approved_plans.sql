-- Additive rollout: retain goals and all existing FK children/history.
CREATE TABLE plan_versions (
 id TEXT PRIMARY KEY NOT NULL,
 goal_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0),
 source_attempt_id TEXT NOT NULL,
 source_run_id TEXT NOT NULL,
 goal_revision INTEGER NOT NULL CHECK(goal_revision>=0),
 calendar_revision_before INTEGER NOT NULL CHECK(calendar_revision_before>=0),
 calendar_revision_after INTEGER NOT NULL CHECK(calendar_revision_after=calendar_revision_before+1),
 request_key TEXT NOT NULL,
 request_payload TEXT NOT NULL CHECK(json_valid(request_payload)),
 context_json TEXT NOT NULL CHECK(json_valid(context_json)),
 draft_json TEXT NOT NULL CHECK(json_valid(draft_json)),
 schedule_json TEXT NOT NULL CHECK(json_valid(schedule_json)),
 accepted_at INTEGER NOT NULL CHECK(accepted_at>0),
 UNIQUE(goal_id,version),
 UNIQUE(owner_id,request_key),
 UNIQUE(id,goal_id,owner_id),
 FOREIGN KEY(goal_id,owner_id) REFERENCES goals(id,owner_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE tasks (
 id TEXT NOT NULL,
 plan_version_id TEXT NOT NULL,
 goal_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 logical_task_key TEXT NOT NULL,
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
 instructions TEXT NOT NULL CHECK(length(instructions) BETWEEN 1 AND 400),
 duration_minutes INTEGER NOT NULL CHECK(duration_minutes BETWEEN 5 AND 120),
 PRIMARY KEY(id,plan_version_id),
 UNIQUE(plan_version_id,logical_task_key),
 UNIQUE(id,plan_version_id,goal_id,owner_id),
 FOREIGN KEY(plan_version_id,goal_id,owner_id) REFERENCES plan_versions(id,goal_id,owner_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE scheduled_occurrences (
 id TEXT PRIMARY KEY NOT NULL,
 task_id TEXT NOT NULL,
 plan_version_id TEXT NOT NULL,
 goal_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 instance_key TEXT NOT NULL,
 start_at INTEGER NOT NULL CHECK(start_at>=0),
 end_at INTEGER NOT NULL CHECK(end_at>start_at),
 timezone TEXT NOT NULL CHECK(timezone IN ('UTC','Asia/Shanghai')),
 status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','completed','skipped','superseded','cancelled')),
 created_at INTEGER NOT NULL CHECK(created_at>0),
 UNIQUE(plan_version_id,instance_key),
 FOREIGN KEY(task_id,plan_version_id,goal_id,owner_id) REFERENCES tasks(id,plan_version_id,goal_id,owner_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX idx_occurrences_owner_time ON scheduled_occurrences(owner_id,start_at,end_at);
-- Canonical active pointer: legacy goals.active_plan_version_id remains reserved NULL.
CREATE TABLE goal_active_plans (
 goal_id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 plan_version_id TEXT NOT NULL,
 FOREIGN KEY(goal_id,owner_id) REFERENCES goals(id,owner_id) ON DELETE CASCADE,
 FOREIGN KEY(plan_version_id,goal_id,owner_id) REFERENCES plan_versions(id,goal_id,owner_id) ON DELETE CASCADE
) STRICT;
