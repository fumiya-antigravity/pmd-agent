/* ===================================================
   Crew: Planner AI — Why特化の壁打ち計画
   責務: ユーザー入力から壁打ち計画を生成
   
   新JSON構造: cognitive_filter → current_state → core_purpose → tasks
   =================================================== */

const IntentCrew = (() => {
    'use strict';

    /**
     * 初回分析用メッセージ配列を構築
     * @param {string} userMessage - 概要+Why
     * @returns {Array} メッセージ配列
     */
    function buildInitialMessages(userMessage) {
        const prompt = IntentPrompt.buildInitial();

        return [
            { role: 'system', content: prompt },
            { role: 'user', content: userMessage },
        ];
    }

    /**
     * Turn2+: 前回のPlan引き継ぎ + ユーザー回答判定
     * @param {string} userMessage - ユーザーの新しい発言
     * @param {Object} prevPlan - 前回のPlan全体（DB保存形式）
     * @returns {Array} メッセージ配列
     */
    function buildSessionMessages(userMessage, prevPlan) {
        // 回答済みタスクのサマリーを生成（構造化された回答のみ抽出）
        const answeredSummary = (prevPlan?.tasks || [])
            .filter(t => t.result && typeof t.result === 'object' && Object.keys(t.result).length > 0)
            .map(t => `- Step${t.step} "${t.name}": ${JSON.stringify(t.result)}`)
            .join('\n') || null;

        const prompt = IntentPrompt.buildSession(
            prevPlan?.rawGoal || prevPlan?.goal_text || '',
            prevPlan?.sessionPurpose || prevPlan?.session_purpose || '',
            prevPlan?.tasks || [],
            prevPlan?.cognitive_filter || {},
            prevPlan?.why_completeness_score || 0,
            prevPlan?.current_task_index || 0,
            answeredSummary  // ← 追加: スライダー回答の構造化サマリー
        );

        return [
            { role: 'system', content: prompt },
            { role: 'user', content: userMessage },
        ];
    }

    /**
     * Planner結果をパース・検証・正規化
     * LLMの新JSON構造 → DB保存/UI表示互換形式に変換
     * @param {Object} result - APIレスポンスのパース結果
     * @returns {Object} 正規化されたPlanner結果
     */
    function parseResult(result) {
        console.log('[Planner] 結果パース開始');

        // === cognitive_filter ===
        const cf = result.cognitive_filter || {};
        if (!Array.isArray(cf.detected_how_what)) cf.detected_how_what = [];
        console.log('[Planner] cognitive_filter: How/What ' + cf.detected_how_what.length + '語検出');
        console.log('[Planner]   除外語: ' + cf.detected_how_what.join(', '));

        // === current_state ===
        const cs = result.current_state || {};
        if (!Array.isArray(cs.asIs)) cs.asIs = [];
        if (!Array.isArray(cs.assumptions)) cs.assumptions = [];
        console.log('[Planner] asIs: ' + cs.asIs.length + '件, assumptions: ' + cs.assumptions.length + '件');

        // === core_purpose ===
        const cp = result.core_purpose || {};
        if (!cp.rawGoal || typeof cp.rawGoal !== 'string') {
            console.warn('[Planner] rawGoalが未設定、フォールバック');
            cp.rawGoal = '不明';
        }
        if (!cp.abstractGoal) cp.abstractGoal = cp.rawGoal;
        if (!cp.sessionPurpose) {
            console.warn('[Planner] sessionPurposeが未設定、abstractGoalをフォールバック');
            cp.sessionPurpose = cp.abstractGoal;
        }
        if (typeof cp.why_completeness_score !== 'number') cp.why_completeness_score = 0;
        console.log('[Planner] rawGoal: ' + cp.rawGoal.substring(0, 100));
        console.log('[Planner] abstractGoal: ' + cp.abstractGoal.substring(0, 100));
        console.log('[Planner] sessionPurpose: ' + cp.sessionPurpose.substring(0, 150));
        console.log('[Planner] why_completeness_score: ' + cp.why_completeness_score + '%');

        // === tasks ===
        if (!Array.isArray(result.tasks) || result.tasks.length === 0) {
            console.warn('[Planner] tasksが空、デフォルトタスク生成');
            result.tasks = [
                {
                    step: 1,
                    name: 'そもそもなぜこれをやりたいと思ったのか、そのきっかけとなった具体的な出来事を聞く',
                    why: '動機が不明なため。手段ではなく原体験を聞くことでWhyの解像度を上げる',
                    forbidden_words: [],
                    doneWhen: 'ユーザーが具体的なエピソード（日時・場面・相手）を1つ以上語った時',
                },
            ];
        }

        // tasks: step/forbidden_words/status補完
        result.tasks.forEach((task, i) => {
            if (!task.step) task.step = i + 1;
            if (!task.id) task.id = `task_${task.step}`;
            if (!task.name) task.name = `タスク${task.step}`;
            if (!task.why) task.why = '';
            if (!task.doneWhen) task.doneWhen = '';
            if (!Array.isArray(task.forbidden_words)) task.forbidden_words = [];
            if (!task.status) task.status = 'pending';
            if (!task.retryReason) task.retryReason = '';

            // アキネーター形式対応
            if (!task.question_type) task.question_type = 'scale';
            if (!Array.isArray(task.options)) task.options = [];

            // priority互換: stepをpriorityとして使用
            task.priority = task.step;
        });

        console.log('[Planner] タスク: ' + result.tasks.length + '件');
        result.tasks.forEach(t => {
            const icon = t.status === 'done' ? '✓' : t.status === 'retry' ? '↻' : t.status === 'new' ? '+' : '…';
            console.log(`  [step ${t.step}] ${icon} ${t.name}`);
        });

        // === 正規化: DB保存/UI表示互換のフラット構造に変換 ===
        const normalized = {
            // cognitive_filter（そのまま保持 — DB JSONB保存）
            cognitive_filter: cf,
            // core_purpose フラット化
            rawGoal: cp.rawGoal,
            abstractGoal: cp.abstractGoal,
            goal: cp.rawGoal,  // DB互換: goal_text
            sessionPurpose: cp.sessionPurpose,
            sessionPurposeUpdated: cp.sessionPurposeUpdated || false,
            sessionPurposeUpdateReason: cp.sessionPurposeUpdateReason || '',
            rawGoalUpdated: cp.rawGoalUpdated || false,
            why_completeness_score: cp.why_completeness_score,
            // current_state フラット化
            asIs: cs.asIs,
            assumptions: cs.assumptions,
            // tasks（そのまま）
            tasks: result.tasks,
            // gap互換: scoreベースで生成
            gap: `why_completeness: ${cp.why_completeness_score}%`,
        };

        return normalized;
    }

    return { buildInitialMessages, buildSessionMessages, parseResult };
})();
