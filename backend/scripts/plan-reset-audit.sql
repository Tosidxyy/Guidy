-- Aggregate counts only: no addresses, user answers, keys or generated content.
SELECT 'users' AS category,count(*) AS total FROM "user"
;
SELECT 'sessions' AS category,count(*) AS total FROM session
;
SELECT 'profiles' AS category,count(*) AS total FROM profiles
;
SELECT 'goals' AS category,count(*) AS total FROM goals
;
SELECT 'user_facts' AS category,count(*) AS total FROM goal_slots
;
SELECT 'chat_captures' AS category,count(*) AS total FROM chat_condition_captures
;
SELECT 'user_messages' AS category,count(*) AS total FROM agent_messages WHERE role='user'
;
SELECT 'fixed_events' AS category,count(*) AS total FROM calendar_events
;
SELECT 'search_usage' AS category,count(*) AS total FROM search_usage
;
SELECT 'plan_usage' AS category,count(*) AS total FROM plan_draft_usage
;
SELECT 'old_planning_jobs' AS category,count(*) AS total FROM planning_jobs WHERE created_at<=1791978470000
;
SELECT 'old_plans' AS category,count(*) AS total FROM plan_draft_attempts WHERE created_at<=1791978470000
;
SELECT 'old_reviews' AS category,count(*) AS total FROM plan_draft_reviews WHERE attempt_id IN(SELECT id FROM plan_draft_attempts WHERE created_at<=1791978470000)
;
SELECT 'old_search_results' AS category,count(*) AS total FROM search_attempts WHERE created_at<=1791978470000
;
SELECT 'old_source_jobs' AS category,count(*) AS total FROM agent_jobs WHERE created_at<=1791978470000
;
SELECT 'old_sources' AS category,count(*) AS total FROM research_evidence WHERE created_at<=1791978470000
;
SELECT 'old_embedded_plans' AS category,count(*) AS total FROM agent_runs WHERE created_at<=1791978470000 AND (json_extract(reply_json,'$.schedule') IS NOT NULL OR json_extract(reply_json,'$.edit_proposal') IS NOT NULL);
