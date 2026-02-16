/* ===================================================
   Crew: Phase0 — Goal特定 + タスク分解
   責務: ユーザー入力からGoal/As-is/Gap/タスクを特定し、
   Phase1用のタスクリストを生成する

   プロンプト組立: IntentPrompt.buildInitial/buildSession()
   =================================================== */

const IntentCrew = (() => {
    'use strict';

    /**
     * 初回分析用メッセージ配列を構築
     * @param {string} userMessage - 概要+Why
     * @param {string|null} personality - user_context.raw_personality
     * @returns {Array} メッセージ配列
     */
    function buildInitialMessages(userMessage, personality) {
        const layer3 = RulesLoader.getForPhase0();
        const prompt = IntentPrompt.buildInitial(layer3, personality);

        return [
            { role: 'system', content: prompt },
            { role: 'user', content: userMessage },
        ];
    }

    /**
     * セッション継続用メッセージ配列を構築（Goal更新判定）
     * @param {string} userMessage - ユーザーの新しい発言
     * @param {string|null} personality - パーソナリティ
     * @param {string|null} previousGoal - 前回のGoal
     * @param {Array|null} previousTasks - 前回のタスク分解
     * @param {string|null} progressSummary - セッション進捗
     * @returns {Array} メッセージ配列
     */
    function buildSessionMessages(userMessage, personality, previousGoal, previousTasks, progressSummary) {
        const layer3 = RulesLoader.getForPhase0();
        const prompt = IntentPrompt.buildSession(
            layer3, personality, previousGoal, previousTasks, progressSummary
        );

        return [
            { role: 'system', content: prompt },
            { role: 'user', content: userMessage },
        ];
    }

    /**
     * Phase0の結果をパース・検証
     * @param {Object} result - APIレスポンスのパース結果
     * @returns {Object} 検証済みのPhase0結果
     */
    function parseResult(result) {
        console.log('[IntentCrew] Phase0結果パース');

        // goal
        if (!result.goal || typeof result.goal !== 'string') {
            console.warn('[IntentCrew] goalが未設定、フォールバック');
            result.goal = '不明';
        }
        console.log('[IntentCrew] Goal: ' + result.goal.substring(0, 100));

        // asIs
        if (!Array.isArray(result.asIs)) {
            result.asIs = [];
        }
        console.log('[IntentCrew] As-is: ' + result.asIs.length + '項目');

        // gap
        if (!result.gap) result.gap = '';

        // tasks
        if (!Array.isArray(result.tasks) || result.tasks.length === 0) {
            console.warn('[IntentCrew] tasksが空、デフォルトタスク生成');
            result.tasks = [
                {
                    id: 'task_default',
                    name: 'ユーザーのGoalの解像度を上げる',
                    why: 'Goalの記述が抽象的なため、具体化が必要',
                    doneWhen: 'Goalに含まれる曖昧な用語が具体的なシーンで説明されている',
                    priority: 1,
                },
            ];
        }

        // tasks: id/priority補完
        result.tasks.forEach((task, i) => {
            if (!task.id) task.id = `task_${i + 1}`;
            if (!task.priority) task.priority = i + 1;
            if (!task.name) task.name = `タスク${i + 1}`;
            if (!task.why) task.why = '';
            if (!task.doneWhen) task.doneWhen = '';
        });

        console.log('[IntentCrew] タスク: ' + result.tasks.length + '件');
        result.tasks.forEach(t => {
            console.log(`  [${t.id}] p${t.priority}: ${t.name}`);
        });

        return result;
    }

    return { buildInitialMessages, buildSessionMessages, parseResult };
})();
