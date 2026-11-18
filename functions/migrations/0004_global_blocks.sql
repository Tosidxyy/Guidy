-- 日历是全局的：plan_id 为空代表访客级公共块（忙时/固定日程）
ALTER TABLE app.blocks ALTER COLUMN plan_id DROP NOT NULL;
ALTER TABLE app.blocks ADD COLUMN owner_visitor_id text;
-- 访客级公共块：plan_id 为空 + owner_visitor_id 归属；计划块保持 plan_id 非空（本迁移后允许为空）
