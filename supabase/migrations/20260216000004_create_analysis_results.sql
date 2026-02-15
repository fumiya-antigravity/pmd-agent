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
