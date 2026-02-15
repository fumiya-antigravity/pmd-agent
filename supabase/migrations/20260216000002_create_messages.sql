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
