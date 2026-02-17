/**
 * Supabase Client — フロントエンド用
 * CDN版 supabase-js を使用（Node.js不要）
 */

// Supabase CDN（index_v2.htmlで読み込み）
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>

const SupabaseClient = (() => {
    const SUPABASE_URL = 'https://mfwgpicsalflypomhuly.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1md2dwaWNzYWxmbHlwb21odWx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzExNDU0ODAsImV4cCI6MjA4NjcyMTQ4MH0.f-jKJMCSl7r7KZztNCVw_VmznNCPP1AapjxD2oFrTIE';

    let client = null;

    function getClient() {
        if (!client) {
            if (typeof supabase === 'undefined') {
                console.error('[SupabaseClient] supabase-js CDN が読み込まれていません');
                return null;
            }
            client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
            console.log('[SupabaseClient] 初期化完了');
        }
        return client;
    }

    // ===================================================
    // Sessions CRUD
    // ===================================================

    async function createSession(title = '新しい壁打ち', overview = '', whyText = '') {
        const { data, error } = await getClient()
            .from('sessions')
            .insert({ title, overview, why_text: whyText, phase: 'WELCOME' })
            .select()
            .single();
        if (error) { console.error('[createSession]', error); throw error; }
        console.log('[createSession] 成功:', data.id);
        return data;
    }

    async function getSession(sessionId) {
        const { data, error } = await getClient()
            .from('sessions')
            .select('*')
            .eq('id', sessionId)
            .single();
        if (error) { console.error('[getSession]', error); throw error; }
        return data;
    }

    async function listSessions(limit = 20) {
        const { data, error } = await getClient()
            .from('sessions')
            .select('id, title, phase, created_at, updated_at')
            .order('updated_at', { ascending: false })
            .limit(limit);
        if (error) { console.error('[listSessions]', error); throw error; }
        return data;
    }

    async function updateSession(sessionId, updates) {
        const { data, error } = await getClient()
            .from('sessions')
            .update(updates)
            .eq('id', sessionId)
            .select()
            .single();
        if (error) { console.error('[updateSession]', error); throw error; }
        return data;
    }

    // ===================================================
    // Messages CRUD
    // ===================================================

    async function saveMessage(sessionId, role, content, metadata = {}) {
        // ターン番号を自動計算
        const { count } = await getClient()
            .from('messages')
            .select('*', { count: 'exact', head: true })
            .eq('session_id', sessionId);

        const { data, error } = await getClient()
            .from('messages')
            .insert({
                session_id: sessionId,
                role,
                content,
                metadata,
                turn_number: (count || 0) + 1,
            })
            .select()
            .single();
        if (error) { console.error('[saveMessage]', error); throw error; }
        return data;
    }

    async function getMessages(sessionId, limit = 50) {
        const { data, error } = await getClient()
            .from('messages')
            .select('*')
            .eq('session_id', sessionId)
            .order('turn_number', { ascending: true })
            .limit(limit);
        if (error) { console.error('[getMessages]', error); throw error; }
        return data;
    }

    async function getRecentMessages(sessionId, limit = 10) {
        const { data, error } = await getClient()
            .from('messages')
            .select('role, content')
            .eq('session_id', sessionId)
            .order('turn_number', { ascending: false })
            .limit(limit);
        if (error) { console.error('[getRecentMessages]', error); throw error; }
        // 降順で取得しているので反転
        return (data || []).reverse();
    }

    // ===================================================
    // Aspect States CRUD
    // ===================================================

    async function upsertAspectState(sessionId, aspectKey, updates) {
        const payload = {
            session_id: sessionId,
            aspect_key: aspectKey,
            ...updates,
        };

        // versionをインクリメント
        const existing = await getAspectState(sessionId, aspectKey);
        if (existing) {
            payload.version = (existing.version || 0) + 1;
        }

        const { data, error } = await getClient()
            .from('aspect_states')
            .upsert(payload, { onConflict: 'session_id,aspect_key' })
            .select()
            .single();
        if (error) { console.error('[upsertAspectState]', error); throw error; }
        return data;
    }

    async function getAspectState(sessionId, aspectKey) {
        const { data, error } = await getClient()
            .from('aspect_states')
            .select('*')
            .eq('session_id', sessionId)
            .eq('aspect_key', aspectKey)
            .maybeSingle();
        if (error) { console.error('[getAspectState]', error); throw error; }
        return data;
    }

    async function getAllAspectStates(sessionId) {
        const { data, error } = await getClient()
            .from('aspect_states')
            .select('*')
            .eq('session_id', sessionId);
        if (error) { console.error('[getAllAspectStates]', error); throw error; }

        // オブジェクト形式に変換
        const result = {};
        (data || []).forEach(row => {
            result[row.aspect_key] = row;
        });
        return result;
    }

    // ===================================================
    // Analysis Results CRUD
    // ===================================================

    async function saveAnalysisResult(sessionId, messageId, analysisType, result) {
        const { data, error } = await getClient()
            .from('analysis_results')
            .insert({
                session_id: sessionId,
                message_id: messageId,
                analysis_type: analysisType,
                aspect_update: result.aspectUpdate || {},
                related_updates: result.relatedUpdates || [],
                contamination: result.contamination || {},
                cross_check: result.crossCheck || {},
                thinking: result.thinking || '',
                raw_response: result,
            })
            .select()
            .single();
        if (error) { console.error('[saveAnalysisResult]', error); throw error; }
        return data;
    }

    async function getAnalysisResults(sessionId, limit = 20) {
        const { data, error } = await getClient()
            .from('analysis_results')
            .select('*')
            .eq('session_id', sessionId)
            .order('created_at', { ascending: false })
            .limit(limit);
        if (error) { console.error('[getAnalysisResults]', error); throw error; }
        return data;
    }

    // ===================================================
    // Aspect Snapshots CRUD（Vol履歴）
    // ===================================================

    async function saveSnapshot(sessionId, volNumber, messageId, snapshot) {
        const { data, error } = await getClient()
            .from('aspect_snapshots')
            .upsert({
                session_id: sessionId,
                vol_number: volNumber,
                message_id: messageId,
                snapshot,
            }, { onConflict: 'session_id,vol_number' })
            .select()
            .single();
        if (error) { console.error('[saveSnapshot]', error); throw error; }
        return data;
    }

    async function getSnapshots(sessionId) {
        const { data, error } = await getClient()
            .from('aspect_snapshots')
            .select('*')
            .eq('session_id', sessionId)
            .order('vol_number', { ascending: true });
        if (error) { console.error('[getSnapshots]', error); throw error; }
        return data || [];
    }

    // ===================================================
    // Goal History CRUD（Goal進化の履歴 — State Machine）
    // ===================================================

    async function saveGoalHistory(sessionId, turnNumber, goalData) {
        const insertData = {
            session_id: sessionId,
            turn_number: turnNumber,
            goal_text: goalData.goal || '',
            goal_updated: goalData.goalUpdated || false,
            update_reason: goalData.updateReason || '',
            session_purpose: goalData.sessionPurpose || '',
            session_purpose_updated: goalData.sessionPurposeUpdated || false,
            session_purpose_update_reason: goalData.sessionPurposeUpdateReason || '',
            tasks: goalData.tasks || [],
            as_is: goalData.asIs || [],
            gap: goalData.gap || '',
            assumptions: goalData.assumptions || [],
            // State Machine用
            cognitive_filter: goalData.cognitive_filter || {},
            current_task_index: goalData.current_task_index || 0,
            why_completeness_score: goalData.why_completeness_score || 0,
            abstract_goal: goalData.abstractGoal || '',
        };

        const { data, error } = await getClient()
            .from('goal_history')
            .insert(insertData)
            .select()
            .single();

        if (error) {
            console.error('[saveGoalHistory]', error);
            throw error;
        }
        return data;
    }

    async function getLatestGoal(sessionId) {
        const { data, error } = await getClient()
            .from('goal_history')
            .select('*')
            .eq('session_id', sessionId)
            .order('turn_number', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) { console.error('[getLatestGoal]', error); throw error; }
        return data;
    }

    async function getGoalHistory(sessionId) {
        const { data, error } = await getClient()
            .from('goal_history')
            .select('*')
            .eq('session_id', sessionId)
            .order('turn_number', { ascending: true });
        if (error) { console.error('[getGoalHistory]', error); throw error; }
        return data || [];
    }

    // ===================================================
    // Public API
    // ===================================================
    return {
        getClient,
        // Sessions
        createSession,
        getSession,
        listSessions,
        updateSession,
        // Messages
        saveMessage,
        getMessages,
        getRecentMessages,
        // Aspect States
        upsertAspectState,
        getAspectState,
        getAllAspectStates,
        // Analysis Results
        saveAnalysisResult,
        getAnalysisResults,
        // Aspect Snapshots
        saveSnapshot,
        getSnapshots,
        // Goal History (State Machine)
        saveGoalHistory,
        getLatestGoal,
        getGoalHistory,
    };
})();
