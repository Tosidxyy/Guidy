CREATE UNIQUE INDEX idx_agent_run_owner_scope ON agent_runs(id,goal_id,owner_id);
CREATE TABLE chat_condition_captures (
 run_id TEXT PRIMARY KEY NOT NULL,
 question_run_id TEXT NOT NULL,
 goal_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 slot_key TEXT NOT NULL CHECK(slot_key IN ('outcome','available_time','constraints')),
 value_json TEXT NOT NULL CHECK(json_valid(value_json)),
 evidence TEXT NOT NULL CHECK(length(evidence) BETWEEN 1 AND 300),
 extraction_version TEXT NOT NULL CHECK(extraction_version='chat-capture-v1'),
 resulting_goal_revision INTEGER NOT NULL CHECK(resulting_goal_revision>0),
 created_at INTEGER NOT NULL,
 FOREIGN KEY(run_id,goal_id,owner_id) REFERENCES agent_runs(id,goal_id,owner_id) ON DELETE CASCADE,
 FOREIGN KEY(question_run_id,goal_id,owner_id) REFERENCES agent_runs(id,goal_id,owner_id) ON DELETE CASCADE
) STRICT;
