-- 认领发布进度：记录本次认领写入的版本号，进程在发布后崩溃时重试可据此判定并回放。
ALTER TABLE app.commit_claims ADD COLUMN claimed_version integer;
