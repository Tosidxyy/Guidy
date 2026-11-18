-- 允许任务定义携带执行细节；可空且无默认值，历史行保持 NULL
ALTER TABLE app.task_defs ADD COLUMN notes text;
