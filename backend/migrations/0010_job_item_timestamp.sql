CREATE TABLE research_job_items_checked (
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
 CHECK((status='available' AND retrieved_at IS NOT NULL AND retrieved_at>0 AND length(excerpt)>0) OR (status!='available' AND retrieved_at IS NULL AND excerpt=''))
) STRICT;
INSERT INTO research_job_items_checked SELECT * FROM research_job_items;
DROP TABLE research_job_items;
ALTER TABLE research_job_items_checked RENAME TO research_job_items;
