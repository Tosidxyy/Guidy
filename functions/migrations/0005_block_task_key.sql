-- 时间块保留任务 key：重新载入后钉住块仍能计入任务频次，删除任务时也能带走未钉住的块。
ALTER TABLE app.blocks ADD COLUMN task_key text;