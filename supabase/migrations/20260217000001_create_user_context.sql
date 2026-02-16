-- ============================================
-- user_context: ユーザーパーソナリティの蓄積（Layer 2 永続部分）
-- セッションを跨いで累積更新される
-- ============================================
CREATE TABLE IF NOT EXISTS user_context (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL DEFAULT 'default',
    -- パーソナリティの自由テキスト要約（最も重要 — そのままプロンプトに注入）
    raw_personality TEXT DEFAULT '',
    -- 理解度の構造化データ
    understanding_level JSONB DEFAULT '{}',
    -- 思考パターン
    thinking_patterns JSONB DEFAULT '{}',
    -- 繰り返し出てくるテーマ
    recurring_concerns JSONB DEFAULT '[]',
    -- 成長の記録
    growth_log JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ユーザーIDのユニーク制約
CREATE UNIQUE INDEX idx_user_context_user_id ON user_context (user_id);

-- 更新時トリガー
CREATE TRIGGER user_context_updated_at
    BEFORE UPDATE ON user_context
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();
