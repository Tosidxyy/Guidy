-- A batch marks the winning revision and records its immutable result atomically.
ALTER TABLE goals ADD COLUMN last_mutation_key TEXT;
CREATE UNIQUE INDEX idx_goals_id_owner ON goals(id, owner_id);
CREATE TABLE goal_mutations (
    owner_id TEXT NOT NULL,
    request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),
    goal_id TEXT NOT NULL,
    request_payload TEXT NOT NULL CHECK(json_valid(request_payload)),
    response_payload TEXT NOT NULL CHECK(json_valid(response_payload)),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    PRIMARY KEY(owner_id, request_key),
    FOREIGN KEY(goal_id, owner_id) REFERENCES goals(id, owner_id) ON DELETE CASCADE
) STRICT;
