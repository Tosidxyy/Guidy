-- 第二阶段：任务完成状态、任务级截止/依赖、版本化提交。
-- 受限 DDL：新增列一律可空且无默认值，历史行由运行时归一化。
ALTER TABLE app.blocks ADD COLUMN status text;
ALTER TABLE app.blocks ADD COLUMN completed_at timestamptz;
ALTER TABLE app.blocks ADD COLUMN actual_duration_min integer;
ALTER TABLE app.blocks ADD COLUMN progress_updated_at timestamptz;
ALTER TABLE app.blocks ADD COLUMN plan_version integer;
ALTER TABLE app.task_defs ADD COLUMN deadline text;
ALTER TABLE app.task_defs ADD COLUMN earliest_start text;
ALTER TABLE app.task_defs ADD COLUMN depends_on text;
ALTER TABLE app.plans ADD COLUMN active_version integer;
ALTER TABLE app.commit_log ADD COLUMN idempotency_key text;