-- 访客级习惯画像：自述文本 + 日历统计画像（带生成日期，按天懒更新）
CREATE TABLE app.profiles (
  visitor_id text PRIMARY KEY,
  habits text NOT NULL DEFAULT '',
  learned jsonb,
  learned_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
