CREATE TABLE goal_slots (
    id TEXT PRIMARY KEY NOT NULL,
    goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    key TEXT NOT NULL CHECK(key IN ('outcome','available_time','constraints')),
    value_json TEXT NOT NULL CHECK(json_valid(value_json) AND json_extract(value_json,'$.schema_version') IS 1 AND json_type(value_json,'$.text') IS 'text'),
    sensitivity TEXT NOT NULL DEFAULT 'private' CHECK(sensitivity = 'private'),
    source TEXT NOT NULL DEFAULT 'user' CHECK(source = 'user'),
    confirmed_at INTEGER CHECK(confirmed_at IS NULL OR confirmed_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
    UNIQUE(goal_id,key),
    CHECK((json_extract(value_json,'$.state') IS 'confirmed' AND length(trim(json_extract(value_json,'$.text'))) BETWEEN 1 AND 300 AND confirmed_at IS NOT NULL)
       OR (json_extract(value_json,'$.state') IS 'unknown' AND json_extract(value_json,'$.text') IS '' AND confirmed_at IS NULL))
) STRICT;
