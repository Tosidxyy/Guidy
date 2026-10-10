CREATE TABLE research_evidence (
 id TEXT PRIMARY KEY NOT NULL,
 goal_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 request_key TEXT NOT NULL,
 request_payload TEXT NOT NULL CHECK(json_valid(request_payload)),
 goal_revision INTEGER NOT NULL CHECK(goal_revision >= 0),
 source_url TEXT NOT NULL CHECK(length(source_url) BETWEEN 1 AND 2000),
 claim TEXT NOT NULL CHECK(length(trim(claim)) BETWEEN 1 AND 300),
 caveat TEXT NOT NULL CHECK(length(caveat) <= 300),
 status TEXT NOT NULL CHECK(status IN ('fetching','available','failed')),
 verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK(verification_status='unverified'),
 title TEXT NOT NULL DEFAULT '' CHECK(length(title)<=160),
 excerpt TEXT NOT NULL DEFAULT '' CHECK(length(excerpt)<=1200),
 error_code TEXT,
 retrieved_at INTEGER,
 created_at INTEGER NOT NULL,
 lease_until INTEGER NOT NULL,
 CHECK((status='available' AND retrieved_at IS NOT NULL AND retrieved_at>0 AND length(excerpt)>0 AND error_code IS NULL) OR (status!='available' AND retrieved_at IS NULL AND excerpt='')),
 UNIQUE(owner_id,request_key),
 FOREIGN KEY(goal_id,owner_id) REFERENCES goals(id,owner_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX idx_research_goal ON research_evidence(goal_id,created_at);
CREATE INDEX idx_research_owner_day ON research_evidence(owner_id,created_at);
CREATE UNIQUE INDEX idx_research_fetching ON research_evidence(goal_id) WHERE status='fetching';
