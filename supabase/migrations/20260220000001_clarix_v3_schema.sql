-- ============================================
-- CLARIX v3 マイグレーション
-- sessions.phase を新設計に更新
-- goal_history に新カラム追加
-- session_anchors, confirmed_insights, reports を新規作成
-- ============================================

-- ─── 1. sessions: phase ENUM を新設計に更新 ───
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_phase_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_phase_check
    CHECK (phase IN (
        'WELCOME',         -- セッション作成直後
        'CONVERSATION',    -- Phase 0: 会話中
        'SLIDER',          -- Phase 0.5: スライダー設定中
        'REPORT',          -- Phase 0.9: レポート生成済み
        'COMPLETE'         -- 完了
    ));

-- 旧フェーズを CONVERSATION に統合
UPDATE sessions SET phase = 'CONVERSATION'
WHERE phase IN ('INITIAL_ANALYSIS', 'WHY_SESSION', 'DEEP_DIVE', 'ASPECT_CHECK');

-- ─── 2. goal_history: 新カラム追加 ───
-- (session_purpose, cognitive_filter, why_completeness_score は既存)
ALTER TABLE goal_history
    ADD COLUMN IF NOT EXISTS mgu INTEGER DEFAULT 0
        CHECK (mgu >= 0 AND mgu <= 100),
    ADD COLUMN IF NOT EXISTS sqc INTEGER DEFAULT 0
        CHECK (sqc >= 0 AND sqc <= 100),
    ADD COLUMN IF NOT EXISTS question_type TEXT DEFAULT 'open'
        CHECK (question_type IN ('open', 'hypothesis')),
    ADD COLUMN IF NOT EXISTS manager_alignment_score INTEGER DEFAULT 100,
    ADD COLUMN IF NOT EXISTS active_sub_questions JSONB DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS turn INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS raw_planner_output JSONB DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS raw_manager_output JSONB DEFAULT NULL;

-- ─── 3. session_anchors: 初回メッセージの永続保存 ───
CREATE TABLE IF NOT EXISTS session_anchors (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id        UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    original_message  TEXT NOT NULL,
    core_keywords     TEXT[] DEFAULT '{}',
    initial_purpose   TEXT DEFAULT '',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_anchors_session
    ON session_anchors (session_id);

-- ─── 4. confirmed_insights: 確認済みインサイト ───
CREATE TABLE IF NOT EXISTS confirmed_insights (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id            UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    label                 TEXT NOT NULL,
    layer                 TEXT NOT NULL CHECK (layer IN ('attribute', 'consequence', 'value')),
    strength              INTEGER NOT NULL DEFAULT 50
                              CHECK (strength >= 0 AND strength <= 100),
    confirmation_strength DECIMAL(3,1) DEFAULT NULL,
    slider_weight         INTEGER DEFAULT NULL,
    tag                   TEXT DEFAULT 'supplementary'
                              CHECK (tag IN ('primary', 'supplementary')),
    turn                  INTEGER NOT NULL DEFAULT 0,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_insights_session
    ON confirmed_insights (session_id, strength DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_insights_upsert
    ON confirmed_insights (session_id, label);

-- ─── 5. reports: 生成レポート保存 ───
CREATE TABLE IF NOT EXISTS reports (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id        UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    report_markdown   TEXT NOT NULL,
    session_purpose   TEXT DEFAULT '',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_session
    ON reports (session_id);
