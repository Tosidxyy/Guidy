-- 原子发布：配置快照与 active_version 同一行更新；幂等认领增加 fencing token 与内容指纹。
ALTER TABLE app.plans ADD COLUMN config jsonb;
ALTER TABLE app.commit_claims ADD COLUMN fence integer;
ALTER TABLE app.commit_claims ADD COLUMN fingerprint text;
