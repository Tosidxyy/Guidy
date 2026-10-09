-- Business timestamps use UTC epoch milliseconds; auth fields follow its generated schema.
CREATE TABLE profiles (
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL DEFAULT '',
    avatar_path TEXT,
    locale TEXT NOT NULL DEFAULT 'zh-CN' CHECK(length(trim(locale)) BETWEEN 1 AND 32),
    timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai' CHECK(length(trim(timezone)) BETWEEN 1 AND 128),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
) STRICT;

CREATE TABLE goals (
    id TEXT PRIMARY KEY NOT NULL CHECK(
        length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-'
        AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'
        AND length(replace(id, '-', '')) = 32
        AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
    owner_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
    category TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','clarifying','researching','awaiting_approval','active','paused','completed','archived')),
    deadline_at INTEGER CHECK(deadline_at IS NULL OR deadline_at >= 0),
    -- M2 introduces plan_versions and its same-goal FK. No dangling pointer is accepted in M0.
    active_plan_version_id TEXT CHECK(active_plan_version_id IS NULL),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
) STRICT;

CREATE INDEX idx_goals_owner_status_updated ON goals(owner_id, status, updated_at DESC);
