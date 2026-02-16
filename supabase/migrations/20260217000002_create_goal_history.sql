-- ============================================
-- goal_history: Goal進化の履歴（Layer 2 動的部分）
-- セッション内のGoalの変遷を追跡
-- ============================================
CREATE TABLE IF NOT EXISTS goal_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_number INTEGER NOT NULL DEFAULT 1,
    -- Goal本文
    goal_text TEXT NOT NULL,
    -- Goal更新があったか
    goal_updated BOOLEAN DEFAULT false,
    -- 更新理由（解像度向上/方向転換等）
    update_reason TEXT DEFAULT '',
    -- タスク分解結果
    tasks JSONB DEFAULT '[]',
    -- As-is（現時点の事実リスト）
    as_is JSONB DEFAULT '[]',
    -- Gap（GoalとAs-isの差分）
    gap TEXT DEFAULT '',
    -- 仮定リスト
    assumptions JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- インデックス
CREATE INDEX idx_goal_history_session_id ON goal_history (session_id);
CREATE INDEX idx_goal_history_turn ON goal_history (session_id, turn_number);
