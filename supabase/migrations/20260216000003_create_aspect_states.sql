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
