CREATE TABLE agent_jobs (
 id TEXT PRIMARY KEY NOT NULL,
 goal_id TEXT NOT NULL,
 owner_id TEXT NOT NULL,
 request_key TEXT NOT NULL,
 request_payload TEXT NOT NULL CHECK(json_valid(request_payload)),
 goal_revision INTEGER NOT NULL CHECK(goal_revision>=0),
 status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
 dispatched INTEGER NOT NULL DEFAULT 0 CHECK(dispatched IN (0,1)),
 error_code TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(owner_id,request_key),
 FOREIGN KEY(goal_id,owner_id) REFERENCES goals(id,owner_id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX idx_research_job_active ON agent_jobs(goal_id) WHERE status IN ('queued','running');
CREATE INDEX idx_research_job_owner_day ON agent_jobs(owner_id,created_at);
CREATE TABLE research_job_items (
 job_id TEXT NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
 position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 2),
 source_url TEXT NOT NULL CHECK(length(source_url)<=2000),
 claim TEXT NOT NULL CHECK(length(claim) BETWEEN 1 AND 300),
 caveat TEXT NOT NULL CHECK(length(caveat)<=300),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reading','available','failed')),
 claim_token TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 2),
 title TEXT NOT NULL DEFAULT '' CHECK(length(title)<=160),
 excerpt TEXT NOT NULL DEFAULT '' CHECK(length(excerpt)<=1200),
 retrieved_at INTEGER,
 error_code TEXT,
 PRIMARY KEY(job_id,position),
 CHECK((status='available' AND retrieved_at>0 AND length(excerpt)>0) OR (status!='available' AND retrieved_at IS NULL AND excerpt=''))
) STRICT;
