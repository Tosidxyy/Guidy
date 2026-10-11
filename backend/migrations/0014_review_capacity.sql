-- User-declared weekly capacity belongs to an immutable review, not a Goal slot.
ALTER TABLE plan_draft_reviews ADD COLUMN weekly_capacity_minutes INTEGER
 CHECK(weekly_capacity_minutes IS NULL OR weekly_capacity_minutes BETWEEN 0 AND 10080);
