-- goal_historyテーブルにsessionPurpose関連カラムを追加
ALTER TABLE goal_history
ADD COLUMN IF NOT EXISTS session_purpose TEXT DEFAULT '',
ADD COLUMN IF NOT EXISTS session_purpose_updated BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS session_purpose_update_reason TEXT DEFAULT '';
