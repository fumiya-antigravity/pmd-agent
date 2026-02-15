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
