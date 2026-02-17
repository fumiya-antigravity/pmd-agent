-- State Machine用カラムを追加
ALTER TABLE goal_history ADD COLUMN IF NOT EXISTS cognitive_filter JSONB DEFAULT '{}';
ALTER TABLE goal_history ADD COLUMN IF NOT EXISTS current_task_index INTEGER DEFAULT 0;
ALTER TABLE goal_history ADD COLUMN IF NOT EXISTS why_completeness_score INTEGER DEFAULT 0;
ALTER TABLE goal_history ADD COLUMN IF NOT EXISTS abstract_goal TEXT DEFAULT '';
