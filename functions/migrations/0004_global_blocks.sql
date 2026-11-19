-- 日历是全局的：访客级公共块用哨兵 plan_id + owner_visitor_id 归属。
-- 受限 DDL 不支持 ALTER COLUMN ... DROP NOT NULL：blocks.plan_id 保持 NOT NULL，
-- 公共块写入哨兵 UUID（shared/constants.ts SHARED_BLOCK_PLAN_ID），并由 ensureSharedPlan 创建系统哨兵计划行满足外键。
ALTER TABLE app.blocks ADD COLUMN owner_visitor_id text;