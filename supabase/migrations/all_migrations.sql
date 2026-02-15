-- ============================================
-- sessions: 壁打ちセッション（スレッド）
-- ============================================
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL DEFAULT '新しい壁打ち',
    overview TEXT DEFAULT '',
    why_text TEXT DEFAULT '',
    phase TEXT NOT NULL DEFAULT 'WELCOME'
        CHECK (phase IN ('WELCOME', 'INITIAL_ANALYSIS', 'WHY_SESSION', 'DEEP_DIVE', 'ASPECT_CHECK', 'COMPLETE')),
    current_aspect TEXT DEFAULT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 更新時に updated_at を自動更新
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_updated_at
    BEFORE UPDATE ON sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- インデックス
CREATE INDEX idx_sessions_created_at ON sessions (created_at DESC);
CREATE INDEX idx_sessions_phase ON sessions (phase);
-- ============================================
-- messages: 会話履歴（全メッセージ永続化）
-- ============================================
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL DEFAULT '',
    metadata JSONB DEFAULT '{}',
    turn_number INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- インデックス
CREATE INDEX idx_messages_session_id ON messages (session_id);
CREATE INDEX idx_messages_session_turn ON messages (session_id, turn_number);
CREATE INDEX idx_messages_role ON messages (role);
-- ============================================
-- aspect_states: 5観点の状態管理（version管理）
-- ============================================
CREATE TABLE IF NOT EXISTS aspect_states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    aspect_key TEXT NOT NULL
        CHECK (aspect_key IN ('background', 'problem', 'target', 'impact', 'urgency')),
    status TEXT NOT NULL DEFAULT 'empty'
        CHECK (status IN ('ok', 'thin', 'empty', 'skipped')),
    text_content TEXT DEFAULT '',
    reason TEXT DEFAULT '',
    advice TEXT DEFAULT '',
    quoted TEXT DEFAULT '',
    example TEXT DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    updated_by TEXT DEFAULT 'initial'
        CHECK (updated_by IN ('initial', 'user', 'ai_direct', 'ai_related', 'manual')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- セッション×観点のユニーク制約
CREATE UNIQUE INDEX idx_aspect_states_unique
    ON aspect_states (session_id, aspect_key);

-- インデックス
CREATE INDEX idx_aspect_states_session_id ON aspect_states (session_id);
CREATE INDEX idx_aspect_states_status ON aspect_states (status);

-- 更新時トリガー
CREATE TRIGGER aspect_states_updated_at
    BEFORE UPDATE ON aspect_states
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();
-- ============================================
-- analysis_results: AI分析結果の全記録
-- ============================================
CREATE TABLE IF NOT EXISTS analysis_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    analysis_type TEXT NOT NULL DEFAULT 'why_session'
        CHECK (analysis_type IN ('initial_analysis', 'why_session', 'deep_dive', 'verify', 'supplement')),
    aspect_update JSONB DEFAULT '{}',
    related_updates JSONB DEFAULT '[]',
    contamination JSONB DEFAULT '{}',
    cross_check JSONB DEFAULT '{}',
    thinking TEXT DEFAULT '',
    raw_response JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- インデックス
CREATE INDEX idx_analysis_results_session_id ON analysis_results (session_id);
CREATE INDEX idx_analysis_results_type ON analysis_results (analysis_type);
CREATE INDEX idx_analysis_results_message_id ON analysis_results (message_id);
