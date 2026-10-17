-- Discussion is a proposal channel. Only explicit calendar confirmation writes events.
CREATE TABLE conversation_turns (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
 request_key TEXT NOT NULL,
 request_payload TEXT NOT NULL,
 goal_revision INTEGER NOT NULL,
 base_attempt_id TEXT NOT NULL,
 user_text TEXT NOT NULL CHECK(length(user_text) BETWEEN 1 AND 600),
 status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
 reply_json TEXT,
 error_code TEXT,
 created_at INTEGER NOT NULL,
 UNIQUE(owner_id,request_key)
) STRICT;
CREATE INDEX idx_conversation_goal ON conversation_turns(owner_id,goal_id,created_at);
CREATE INDEX idx_conversation_budget ON conversation_turns(created_at,owner_id);
CREATE TABLE calendar_event_receipts (
 owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 request_key TEXT NOT NULL,
 request_payload TEXT NOT NULL,
 event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL,
 PRIMARY KEY(owner_id,request_key)
) STRICT;
