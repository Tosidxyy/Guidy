CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY NOT NULL,
    goal_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    request_key TEXT NOT NULL,
    request_payload TEXT NOT NULL,
    turn_index INTEGER NOT NULL CHECK(turn_index > 0),
    goal_revision INTEGER NOT NULL CHECK(goal_revision >= 0),
    user_text TEXT NOT NULL CHECK(length(trim(user_text)) BETWEEN 1 AND 600),
    requested_model TEXT NOT NULL DEFAULT 'deepseek-flash',
    context_schema_version INTEGER NOT NULL DEFAULT 1 CHECK(context_schema_version = 1),
    harness_version TEXT NOT NULL DEFAULT 'clarify-v1',
    context_json TEXT CHECK(context_json IS NULL OR json_valid(context_json)),
    status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
    reply_json TEXT CHECK(reply_json IS NULL OR json_valid(reply_json)),
    error_code TEXT,
    input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
    output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    lease_until INTEGER NOT NULL,
    UNIQUE(owner_id,request_key),
    UNIQUE(goal_id,turn_index),
    FOREIGN KEY(goal_id,owner_id) REFERENCES goals(id,owner_id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX idx_agent_running_goal ON agent_runs(goal_id) WHERE status='running';
CREATE INDEX idx_agent_daily_owner ON agent_runs(owner_id,created_at);
CREATE INDEX idx_agent_daily_global ON agent_runs(created_at);
CREATE UNIQUE INDEX idx_agent_run_goal ON agent_runs(id,goal_id);
CREATE TABLE agent_messages (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(run_id,role),
    FOREIGN KEY(run_id,goal_id) REFERENCES agent_runs(id,goal_id) ON DELETE CASCADE
) STRICT;
