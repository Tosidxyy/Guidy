-- User-authorized development reset. Fixed cutoff: 2026-10-14T11:47:50Z.
-- New plans created after the cutoff and all user facts/cost ledgers survive.
-- Stop old jobs first so late provider results cannot save into a deleted job.
DELETE FROM planning_jobs WHERE created_at <= 1791978470000;
DELETE FROM plan_draft_attempts WHERE created_at <= 1791978470000;
DELETE FROM search_attempts WHERE created_at <= 1791978470000;
DELETE FROM agent_jobs WHERE created_at <= 1791978470000;
DELETE FROM research_evidence WHERE created_at <= 1791978470000;

-- Preserve user_text, ordering, provenance and paid-question budget history.
-- Remove embedded generated plans from legacy control runs, not real answers.
UPDATE agent_runs SET status='failed',error_code='CONTEXT_CHANGED',lease_until=0
 WHERE created_at <= 1791978470000 AND status='running'
 AND harness_version IN ('clarify-stop-v1','draft-edit-v1','schedule-chat-v1');
UPDATE agent_runs SET context_json=NULL,request_payload='{}',
 reply_json=CASE WHEN status='succeeded' THEN
 '{"schema_version":1,"kind":"notice","question":"旧方案已清理，可以根据已有回答重新制订。","reason":"你的目标和回答已保留。","source":"harness","requested_slot":null,"stage":"plans_cleared"}'
 ELSE NULL END
 WHERE created_at <= 1791978470000
 AND harness_version IN ('clarify-stop-v1','draft-edit-v1','schedule-chat-v1')
 AND NOT EXISTS(SELECT 1 FROM planning_jobs WHERE source_run_id=agent_runs.id);
UPDATE agent_messages SET content=(SELECT reply_json FROM agent_runs WHERE id=run_id)
 WHERE role='assistant' AND run_id IN (
 SELECT id FROM agent_runs WHERE created_at <= 1791978470000
 AND harness_version IN ('clarify-stop-v1','draft-edit-v1','schedule-chat-v1')
 AND status='succeeded' AND json_extract(reply_json,'$.stage')='plans_cleared');
DELETE FROM agent_messages WHERE role='assistant' AND run_id IN (
 SELECT id FROM agent_runs WHERE created_at <= 1791978470000
 AND harness_version IN ('clarify-stop-v1','draft-edit-v1','schedule-chat-v1')
 AND status!='succeeded');
