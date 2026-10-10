-- Preserve existing goals. Free-form timeframe is a note, not a scheduled deadline.
ALTER TABLE goals ADD COLUMN description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 300);
ALTER TABLE goals ADD COLUMN timeframe_note TEXT NOT NULL DEFAULT '' CHECK(length(timeframe_note) <= 80);
ALTER TABLE goals ADD COLUMN creation_key TEXT CHECK(creation_key IS NULL OR length(creation_key) BETWEEN 8 AND 128);
CREATE UNIQUE INDEX idx_goals_owner_creation_key ON goals(owner_id, creation_key) WHERE creation_key IS NOT NULL;
