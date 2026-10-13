CREATE TABLE calendar_states (
 owner_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 last_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL
) STRICT;
CREATE TABLE calendar_events (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 source TEXT NOT NULL DEFAULT 'user' CHECK(source='user'),
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
 start_at INTEGER NOT NULL CHECK(start_at>=0),
 end_at INTEGER NOT NULL CHECK(end_at>start_at),
 timezone TEXT NOT NULL CHECK(timezone IN ('UTC','Asia/Shanghai')),
 fixed INTEGER NOT NULL DEFAULT 1 CHECK(fixed=1),
 source_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
 source_goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
 created_at INTEGER NOT NULL,
 UNIQUE(owner_id,start_at,end_at)
) STRICT;
CREATE INDEX idx_calendar_owner_time ON calendar_events(owner_id,start_at,end_at);
