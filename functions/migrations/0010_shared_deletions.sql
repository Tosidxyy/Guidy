-- 共享日历实例删除墓碑：物化块被用户删除后，不再被后续读取重新物化。
CREATE TABLE app.shared_deletions (
  visitor_id text NOT NULL,
  k text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (visitor_id, k)
);
