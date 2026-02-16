-- ============================================
-- session_progress: セッション進捗の累積（Layer 1）
-- ターンごとに蓄積される
-- ============================================
CREATE TABLE IF NOT EXISTS session_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_number INTEGER NOT NULL,
    -- このターンで解決した項目
    resolved_items JSONB DEFAULT '[]',
    -- ここまでに蓄積された事実
    accumulated_facts JSONB DEFAULT '[]',
    -- Phase2の統合結果
    synthesis_result JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- インデックス
CREATE INDEX idx_session_progress_session_id ON session_progress (session_id);
CREATE INDEX idx_session_progress_turn ON session_progress (session_id, turn_number DESC);
